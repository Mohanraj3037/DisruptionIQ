import csv
import json
import io
from datetime import datetime, timezone
from werkzeug.utils import secure_filename
from app.extensions import db
from app.models.logistics import Supplier, Warehouse, Inventory, Shipment, ShipmentItem
from app.services.audit_service import record_audit

MAX_FILE_SIZE = 2 * 1024 * 1024  # 2MB Limit
ALLOWED_EXTENSIONS = {'csv', 'json'}


def allowed_file(filename: str) -> bool:
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


def parse_date_safe(date_str: str):
    if not date_str:
        return None
    date_str = str(date_str).strip()
    for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M', '%Y-%m-%d', '%Y-%m-%dT%H:%M:%S', '%Y-%m-%dT%H:%M:%SZ'):
        try:
            return datetime.strptime(date_str.replace('Z', ''), fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    raise ValueError(f"Invalid date format '{date_str}'. Expected YYYY-MM-DD or ISO 8601.")


def process_shipments_import(file_bytes: bytes, filename: str, dry_run: bool = False) -> dict:
    """
    Validates and imports shipments from CSV or JSON content.
    Returns preview summary and detailed error messages if validation fails.
    """
    if len(file_bytes) > MAX_FILE_SIZE:
        return {'success': False, 'errors': ['File size exceeds the 2MB safety threshold.'], 'preview': []}

    safe_name = secure_filename(filename)
    ext = safe_name.rsplit('.', 1)[1].lower() if '.' in safe_name else ''
    if ext not in ALLOWED_EXTENSIONS:
        return {'success': False, 'errors': [f"Unsupported file format '.{ext}'. Only CSV and JSON are allowed."], 'preview': []}

    rows = []
    try:
        if ext == 'csv':
            content = file_bytes.decode('utf-8-sig', errors='replace')
            reader = csv.DictReader(io.StringIO(content))
            for r in reader:
                # Strip keys and values
                clean_row = {k.strip(): (v.strip() if v else '') for k, v in r.items() if k}
                rows.append(clean_row)
        else:
            data = json.loads(file_bytes.decode('utf-8', errors='replace'))
            if isinstance(data, list):
                rows = data
            elif isinstance(data, dict) and 'shipments' in data:
                rows = data['shipments']
            else:
                return {'success': False, 'errors': ['JSON structure must be an array of shipment objects or { "shipments": [...] }.'], 'preview': []}
    except Exception as e:
        return {'success': False, 'errors': [f'File parsing error: {str(e)}'], 'preview': []}

    if not rows:
        return {'success': False, 'errors': ['The uploaded file contains no data rows.'], 'preview': []}

    errors = []
    valid_records = []
    warehouses_cache = {w.code: w for w in Warehouse.query.all()}
    suppliers_cache = {s.code: s for s in Supplier.query.all()}

    valid_statuses = {'Scheduled', 'In Transit', 'Delayed', 'Delivered', 'Cancelled'}
    valid_modes = {'Ocean', 'Air', 'Road', 'Rail'}

    for idx, r in enumerate(rows, start=1):
        row_errors = []
        tracking = r.get('tracking_number', '').strip()
        if not tracking:
            row_errors.append("Missing required field 'tracking_number'.")

        dest_wh_code = r.get('destination_warehouse_code', '').strip()
        dest_wh = warehouses_cache.get(dest_wh_code)
        if not dest_wh:
            row_errors.append(f"Destination warehouse '{dest_wh_code}' does not exist.")

        sup_code = r.get('supplier_code', '').strip()
        sup = suppliers_cache.get(sup_code) if sup_code else None
        if sup_code and not sup:
            row_errors.append(f"Supplier '{sup_code}' does not exist.")

        carrier = r.get('carrier', 'Unassigned Carrier').strip()
        mode = r.get('transport_mode', 'Ocean').strip()
        if mode not in valid_modes:
            row_errors.append(f"Invalid transport mode '{mode}'. Must be one of {valid_modes}.")

        status = r.get('status', 'In Transit').strip()
        if status not in valid_statuses:
            row_errors.append(f"Invalid status '{status}'. Must be one of {valid_statuses}.")

        try:
            est_dep = parse_date_safe(r.get('estimated_departure'))
        except ValueError as ve:
            row_errors.append(f"Estimated departure: {str(ve)}")
            est_dep = None

        try:
            est_arr = parse_date_safe(r.get('estimated_arrival'))
        except ValueError as ve:
            row_errors.append(f"Estimated arrival: {str(ve)}")
            est_arr = None

        if row_errors:
            errors.append(f"Row {idx} ({tracking or 'Unknown'}): " + " | ".join(row_errors))
        else:
            valid_records.append({
                'tracking_number': tracking,
                'carrier': carrier,
                'transport_mode': mode,
                'status': status,
                'origin_city': r.get('origin_city', 'Global Hub').strip(),
                'destination_warehouse_id': dest_wh.id,
                'supplier_id': sup.id if sup else None,
                'estimated_departure': est_dep,
                'estimated_arrival': est_arr,
                'sku': r.get('sku', '').strip(),
                'item_name': r.get('item_name', '').strip(),
                'quantity': int(r.get('quantity', 0)) if str(r.get('quantity', '')).isdigit() else 0,
            })

    if errors:
        return {
            'success': False,
            'total_rows': len(rows),
            'valid_count': len(valid_records),
            'errors': errors,
            'preview': valid_records[:5]
        }

    # If dry run, return preview without committing
    if dry_run:
        return {
            'success': True,
            'dry_run': True,
            'total_rows': len(rows),
            'valid_count': len(valid_records),
            'errors': [],
            'preview': valid_records[:5]
        }

    # Atomic Database Commit with rollback on error
    try:
        imported_count = 0
        updated_count = 0
        for rec in valid_records:
            existing = Shipment.query.filter_by(tracking_number=rec['tracking_number']).first()
            if existing:
                existing.carrier = rec['carrier']
                existing.transport_mode = rec['transport_mode']
                existing.status = rec['status']
                existing.destination_warehouse_id = rec['destination_warehouse_id']
                existing.supplier_id = rec['supplier_id']
                if rec['estimated_departure']:
                    existing.estimated_departure = rec['estimated_departure']
                if rec['estimated_arrival']:
                    existing.estimated_arrival = rec['estimated_arrival']
                shp_obj = existing
                updated_count += 1
            else:
                shp_obj = Shipment(
                    tracking_number=rec['tracking_number'],
                    carrier=rec['carrier'],
                    transport_mode=rec['transport_mode'],
                    status=rec['status'],
                    origin_city=rec['origin_city'],
                    destination_warehouse_id=rec['destination_warehouse_id'],
                    supplier_id=rec['supplier_id'],
                    estimated_departure=rec['estimated_departure'],
                    estimated_arrival=rec['estimated_arrival'],
                )
                db.session.add(shp_obj)
                db.session.flush()
                imported_count += 1

            if rec['sku']:
                item_qty = max(1, rec['quantity'])
                existing_item = shp_obj.items.filter_by(sku=rec['sku']).first()
                if not existing_item:
                    s_item = ShipmentItem(
                        shipment_id=shp_obj.id,
                        sku=rec['sku'],
                        item_name=rec['item_name'] or rec['sku'],
                        quantity=item_qty
                    )
                    db.session.add(s_item)

        imported_keys = [r['tracking_number'] for r in valid_records[:5]]
        record_audit(
            action='IMPORT_SHIPMENTS',
            entity_type='Shipment',
            details=f"Imported {imported_count} new shipments ({', '.join(imported_keys)}), updated {updated_count} from {safe_name}."
        )
        db.session.commit()

        return {
            'success': True,
            'total_rows': len(rows),
            'imported': imported_count,
            'updated': updated_count,
            'errors': []
        }
    except Exception as exc:
        db.session.rollback()
        return {'success': False, 'errors': [f'Database transaction failed: {str(exc)}'], 'preview': []}


def process_inventory_import(file_bytes: bytes, filename: str, dry_run: bool = False) -> dict:
    """
    Validates and imports inventory records across warehouses from CSV or JSON.
    Enforces non-negative constraints and valid warehouse references.
    """
    if len(file_bytes) > MAX_FILE_SIZE:
        return {'success': False, 'errors': ['File size exceeds the 2MB safety threshold.'], 'preview': []}

    safe_name = secure_filename(filename)
    ext = safe_name.rsplit('.', 1)[1].lower() if '.' in safe_name else ''
    if ext not in ALLOWED_EXTENSIONS:
        return {'success': False, 'errors': [f"Unsupported file format '.{ext}'. Only CSV and JSON are allowed."], 'preview': []}

    rows = []
    try:
        if ext == 'csv':
            content = file_bytes.decode('utf-8-sig', errors='replace')
            reader = csv.DictReader(io.StringIO(content))
            for r in reader:
                rows.append({k.strip(): (v.strip() if v else '') for k, v in r.items() if k})
        else:
            data = json.loads(file_bytes.decode('utf-8', errors='replace'))
            if isinstance(data, list):
                rows = data
            elif isinstance(data, dict) and 'inventory' in data:
                rows = data['inventory']
            else:
                return {'success': False, 'errors': ['JSON structure must be an array of inventory objects or { "inventory": [...] }.'], 'preview': []}
    except Exception as e:
        return {'success': False, 'errors': [f'File parsing error: {str(e)}'], 'preview': []}

    if not rows:
        return {'success': False, 'errors': ['The uploaded file contains no data rows.'], 'preview': []}

    errors = []
    valid_records = []
    warehouses_cache = {w.code: w for w in Warehouse.query.all()}

    for idx, r in enumerate(rows, start=1):
        row_errors = []
        wh_code = r.get('warehouse_code', '').strip()
        wh = warehouses_cache.get(wh_code)
        if not wh:
            row_errors.append(f"Warehouse '{wh_code}' does not exist.")

        sku = r.get('sku', '').strip()
        if not sku:
            row_errors.append("Missing required field 'sku'.")

        item_name = r.get('item_name', '').strip()
        if not item_name:
            row_errors.append("Missing required field 'item_name'.")

        # Numeric validations
        try:
            qty = int(r.get('quantity', 0))
            if qty < 0:
                row_errors.append("Quantity cannot be negative.")
        except ValueError:
            row_errors.append(f"Invalid quantity '{r.get('quantity')}'. Must be an integer.")
            qty = 0

        try:
            res_qty = int(r.get('reserved_quantity', 0))
            if res_qty < 0:
                row_errors.append("Reserved quantity cannot be negative.")
        except ValueError:
            row_errors.append(f"Invalid reserved quantity '{r.get('reserved_quantity')}'. Must be an integer.")
            res_qty = 0

        try:
            reorder = int(r.get('reorder_point', 10))
            if reorder < 0:
                row_errors.append("Reorder point cannot be negative.")
        except ValueError:
            reorder = 10

        try:
            cost = float(r.get('unit_cost', 0.0))
            if cost < 0:
                row_errors.append("Unit cost cannot be negative.")
        except ValueError:
            cost = 0.0

        if row_errors:
            errors.append(f"Row {idx} ({wh_code}/{sku}): " + " | ".join(row_errors))
        else:
            valid_records.append({
                'warehouse_id': wh.id,
                'warehouse_code': wh_code,
                'sku': sku,
                'item_name': item_name,
                'category': r.get('category', 'General Logistics').strip(),
                'quantity': qty,
                'reserved_quantity': res_qty,
                'reorder_point': reorder,
                'unit_cost': cost,
            })

    if errors:
        return {
            'success': False,
            'total_rows': len(rows),
            'valid_count': len(valid_records),
            'errors': errors,
            'preview': valid_records[:5]
        }

    if dry_run:
        return {
            'success': True,
            'dry_run': True,
            'total_rows': len(rows),
            'valid_count': len(valid_records),
            'errors': [],
            'preview': valid_records[:5]
        }

    try:
        imported_count = 0
        updated_count = 0
        now = datetime.now(timezone.utc)
        for rec in valid_records:
            existing = Inventory.query.filter_by(
                warehouse_id=rec['warehouse_id'],
                sku=rec['sku']
            ).first()

            if existing:
                existing.quantity = rec['quantity']
                existing.reserved_quantity = rec['reserved_quantity']
                existing.reorder_point = rec['reorder_point']
                existing.unit_cost = rec['unit_cost']
                existing.item_name = rec['item_name']
                existing.category = rec['category']
                existing.updated_at = now
                updated_count += 1
            else:
                new_inv = Inventory(
                    warehouse_id=rec['warehouse_id'],
                    sku=rec['sku'],
                    item_name=rec['item_name'],
                    category=rec['category'],
                    quantity=rec['quantity'],
                    reserved_quantity=rec['reserved_quantity'],
                    reorder_point=rec['reorder_point'],
                    unit_cost=rec['unit_cost'],
                    updated_at=now
                )
                db.session.add(new_inv)
                imported_count += 1

        imported_keys = [r['sku'] for r in valid_records[:5]]
        record_audit(
            action='IMPORT_INVENTORY',
            entity_type='Inventory',
            details=f"Imported {imported_count} new inventory SKUs ({', '.join(imported_keys)}), updated {updated_count} from {safe_name}."
        )
        db.session.commit()

        return {
            'success': True,
            'total_rows': len(rows),
            'imported': imported_count,
            'updated': updated_count,
            'errors': []
        }
    except Exception as exc:
        db.session.rollback()
        return {'success': False, 'errors': [f'Database transaction failed: {str(exc)}'], 'preview': []}
