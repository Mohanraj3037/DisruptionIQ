import json
from flask import Blueprint, render_template, request, flash, redirect, url_for, Response
from flask_login import login_required
from app.services.import_service import process_shipments_import, process_inventory_import

import_bp = Blueprint('data_import', __name__, url_prefix='/import')


@import_bp.route('', methods=['GET'])
@import_bp.route('/', methods=['GET'])
@login_required
def index():
    return render_template('import/index.html')


@import_bp.route('/upload', methods=['POST'])
@login_required
def upload():
    entity_type = request.form.get('entity_type', 'shipments').lower()
    commit_mode = request.form.get('commit_mode', 'commit')  # 'commit' or 'preview'
    dry_run = (commit_mode == 'preview')

    uploaded_file = request.files.get('file')
    if not uploaded_file or not uploaded_file.filename:
        flash('Please select a valid CSV or JSON file to upload.', 'warning')
        return redirect(url_for('data_import.index'))

    file_bytes = uploaded_file.read()
    filename = uploaded_file.filename

    if entity_type == 'inventory':
        result = process_inventory_import(file_bytes, filename, dry_run=dry_run)
    else:
        result = process_shipments_import(file_bytes, filename, dry_run=dry_run)

    if not result['success']:
        return render_template(
            'import/index.html',
            validation_errors=result.get('errors', []),
            entity_type=entity_type,
            filename=filename
        )

    if dry_run:
        flash(
            f"Preview Verified: {result['valid_count']} of {result['total_rows']} rows are valid and ready to commit.",
            'info'
        )
        return render_template(
            'import/index.html',
            preview_data=result.get('preview', []),
            total_rows=result.get('total_rows', 0),
            valid_count=result.get('valid_count', 0),
            entity_type=entity_type,
            filename=filename
        )

    flash(
        f"Import Completed Successfully: {result.get('imported', 0)} new records created, {result.get('updated', 0)} updated.",
        'success'
    )
    return redirect(url_for('data_import.index'))


@import_bp.route('/sample/<entity>/<fmt>')
@login_required
def download_sample(entity: str, fmt: str):
    """Provides downloadable or viewable sample CSV/JSON templates."""
    if entity == 'inventory':
        if fmt == 'json':
            content = json.dumps([
                {
                    "warehouse_code": "WH-EAST",
                    "sku": "SKU-SAMPLE-01",
                    "item_name": "Optical Coupler Module",
                    "category": "Sensors",
                    "quantity": 100,
                    "reserved_quantity": 10,
                    "reorder_point": 20,
                    "unit_cost": 15.50
                },
                {
                    "warehouse_code": "WH-WEST",
                    "sku": "SKU-SAMPLE-02",
                    "item_name": "Brushless Servo Controller",
                    "category": "Actuators",
                    "quantity": 80,
                    "reserved_quantity": 5,
                    "reorder_point": 15,
                    "unit_cost": 42.00
                }
            ], indent=2)
            mimetype = 'application/json'
            ext = 'json'
        else:
            content = (
                "warehouse_code,sku,item_name,category,quantity,reserved_quantity,reorder_point,unit_cost\n"
                "WH-EAST,SKU-SAMPLE-01,Optical Coupler Module,Sensors,100,10,20,15.50\n"
                "WH-WEST,SKU-SAMPLE-02,Brushless Servo Controller,Actuators,80,5,15,42.00\n"
            )
            mimetype = 'text/csv'
            ext = 'csv'
    else:  # Shipments
        if fmt == 'json':
            content = json.dumps([
                {
                    "tracking_number": "SHP-SMP-001",
                    "carrier": "Maersk Line",
                    "transport_mode": "Ocean",
                    "status": "In Transit",
                    "origin_city": "Yokohama, Japan",
                    "destination_warehouse_code": "WH-WEST",
                    "supplier_code": "SUP-PACIFIC",
                    "estimated_departure": "2026-11-01",
                    "estimated_arrival": "2026-11-15",
                    "sku": "SKU-MCU-01",
                    "item_name": "Cortex-M4 Microcontroller",
                    "quantity": 250
                }
            ], indent=2)
            mimetype = 'application/json'
            ext = 'json'
        else:
            content = (
                "tracking_number,carrier,transport_mode,status,origin_city,destination_warehouse_code,supplier_code,estimated_departure,estimated_arrival,sku,item_name,quantity\n"
                "SHP-SMP-001,Maersk Line,Ocean,In Transit,Yokohama Japan,WH-WEST,SUP-PACIFIC,2026-11-01,2026-11-15,SKU-MCU-01,Cortex-M4 Microcontroller,250\n"
            )
            mimetype = 'text/csv'
            ext = 'csv'

    return Response(
        content,
        mimetype=mimetype,
        headers={"Content-Disposition": f"attachment;filename=sample_{entity}.{ext}"}
    )
