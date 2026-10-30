from datetime import datetime, timezone, timedelta
from app.extensions import db
from app.models.logistics import Supplier, Warehouse, Inventory, Shipment, ShipmentItem
from app.models.orders import CustomerOrder, OrderItem
from app.models.disruptions import Disruption
from app.models.governance import AuditLog


def seed_logistics_data() -> dict:
    """
    Seeds realistic synthetic logistics data if not already present.
    Idempotent: skips existing records to avoid duplicate insertion or resetting data.
    """
    now = datetime.now(timezone.utc)
    summary = {
        'suppliers': 0,
        'warehouses': 0,
        'inventories': 0,
        'shipments': 0,
        'orders': 0,
        'disruptions': 0
    }

    # =========================================================================
    # 1. Five Suppliers
    # =========================================================================
    suppliers_data = [
        {
            'code': 'SUP-PACIFIC',
            'name': 'Pacific Rim Silicon Ltd',
            'country': 'Taiwan',
            'city': 'Hsinchu',
            'reliability_score': 0.94,
            'lead_time_days': 14,
            'expected_supply_date': now + timedelta(days=14),
            'contact_email': 'logistics@pacificrimsilicon.tw',
        },
        {
            'code': 'SUP-APEX',
            'name': 'Apex Precision Foundry GmbH',
            'country': 'Germany',
            'city': 'Stuttgart',
            'reliability_score': 0.98,
            'lead_time_days': 10,
            'expected_supply_date': now + timedelta(days=10),
            'contact_email': 'order-fulfillment@apex-foundry.de',
        },
        {
            'code': 'SUP-NORDIC',
            'name': 'Nordic Sensor Systems AB',
            'country': 'Sweden',
            'city': 'Gothenburg',
            'reliability_score': 0.91,
            'lead_time_days': 8,
            'expected_supply_date': now + timedelta(days=8),
            'contact_email': 'dispatch@nordicsensors.se',
        },
        {
            'code': 'SUP-EUROTRANS',
            'name': 'EuroTrans Enclosures BV',
            'country': 'Netherlands',
            'city': 'Rotterdam',
            'reliability_score': 0.97,
            'lead_time_days': 5,
            'expected_supply_date': now + timedelta(days=5),
            'contact_email': 'support@eurotrans-parts.nl',
        },
        {
            'code': 'SUP-SINGACHIP',
            'name': 'SingaChip Microelectronics Pte',
            'country': 'Singapore',
            'city': 'Jurong',
            'reliability_score': 0.95,
            'lead_time_days': 12,
            'expected_supply_date': now + timedelta(days=12),
            'contact_email': 'inbound@singachip.sg',
        },
    ]

    supplier_map = {}
    for s_data in suppliers_data:
        sup = Supplier.query.filter_by(code=s_data['code']).first()
        if not sup:
            sup = Supplier(**s_data)
            db.session.add(sup)
            db.session.flush()
            summary['suppliers'] += 1
        supplier_map[s_data['code']] = sup

    # =========================================================================
    # 2. Three Warehouses
    # =========================================================================
    warehouses_data = [
        {
            'code': 'WH-EAST',
            'name': 'Rotterdam Eurohub Gateway',
            'location': 'Rotterdam, Netherlands',
            'capacity_sqm': 45000.0,
            'current_utilization': 0.76,
        },
        {
            'code': 'WH-WEST',
            'name': 'Long Beach Strategic Logistics Hub',
            'location': 'Los Angeles, USA',
            'capacity_sqm': 60000.0,
            'current_utilization': 0.88,
        },
        {
            'code': 'WH-CENTRAL',
            'name': 'Singapore Changi Global Fulfilment Hub',
            'location': 'Singapore, Changi',
            'capacity_sqm': 55000.0,
            'current_utilization': 0.62,
        },
    ]

    warehouse_map = {}
    for w_data in warehouses_data:
        wh = Warehouse.query.filter_by(code=w_data['code']).first()
        if not wh:
            wh = Warehouse(**w_data)
            db.session.add(wh)
            db.session.flush()
            summary['warehouses'] += 1
        warehouse_map[w_data['code']] = wh

    # =========================================================================
    # 3. 10 Master SKUs & Inventories Across Warehouses
    # =========================================================================
    skus_catalog = [
        ('SKU-MCU-01', 'Cortex-M4 Industrial Microcontroller', 'Microcontrollers', 28.50),
        ('SKU-MCU-02', 'Dual-Core DSP Signal Processor', 'Microcontrollers', 45.00),
        ('SKU-SNS-01', '6-Axis Inertial IMU Sensor', 'Sensors', 16.80),
        ('SKU-SNS-02', 'Environmental Optical & Temp Sensor', 'Sensors', 22.40),
        ('SKU-ACT-01', 'High-Torque Brushless Servo Actuator', 'Actuators', 115.00),
        ('SKU-ACT-02', 'Precision Stepper Motor Driver', 'Actuators', 34.00),
        ('SKU-PWR-01', '48V/10A Industrial Power Module', 'Power Systems', 68.00),
        ('SKU-BAT-01', '24V 50Ah LiFePO4 Battery Unit', 'Power Systems', 320.00),
        ('SKU-ENC-01', 'IP67 Sealed Aluminum Enclosure', 'Structural', 54.00),
        ('SKU-HAR-01', 'Mil-Spec Braided Wiring Harness', 'Cabling', 19.50),
    ]

    # Inventory Quantities tailored for Scenarios A & B:
    # Scenario A: WH-WEST is low on SKU-MCU-01 (40 total, 30 reserved = 10 available, reorder point 50)
    # Scenario B: WH-EAST is in severe shortage on SKU-SNS-02 (20 total, 15 reserved = 5 available, reorder point 30)
    #             WH-CENTRAL has massive surplus on SKU-SNS-02 (350 total, 50 reserved = 300 available, reorder point 40)
    inventory_spec = {
        'WH-EAST': {
            'SKU-MCU-01': (280, 40, 50),
            'SKU-MCU-02': (150, 20, 30),
            'SKU-SNS-01': (420, 60, 60),
            'SKU-SNS-02': (20, 15, 30),    # Scenario B Shortage! (Only 5 available vs 120 requested)
            'SKU-ACT-01': (90, 15, 20),
            'SKU-ACT-02': (130, 25, 30),
            'SKU-PWR-01': (200, 30, 40),
            'SKU-BAT-01': (80, 10, 15),
            'SKU-ENC-01': (310, 45, 50),
            'SKU-HAR-01': (450, 50, 70),
        },
        'WH-WEST': {
            'SKU-MCU-01': (40, 30, 50),    # Scenario A Shortage! (10 available, waiting on delayed SHP-2026-003)
            'SKU-MCU-02': (210, 30, 40),
            'SKU-SNS-01': (180, 25, 35),
            'SKU-SNS-02': (190, 30, 40),
            'SKU-ACT-01': (140, 20, 25),
            'SKU-ACT-02': (110, 15, 25),
            'SKU-PWR-01': (160, 20, 30),
            'SKU-BAT-01': (95, 12, 20),
            'SKU-ENC-01': (240, 35, 45),
            'SKU-HAR-01': (320, 40, 50),
        },
        'WH-CENTRAL': {
            'SKU-MCU-01': (350, 45, 60),
            'SKU-MCU-02': (320, 50, 50),
            'SKU-SNS-01': (280, 35, 40),
            'SKU-SNS-02': (350, 50, 40),   # Scenario B Surplus! (300 available for cross-warehouse transfer)
            'SKU-ACT-01': (110, 15, 20),
            'SKU-ACT-02': (175, 25, 30),
            'SKU-PWR-01': (240, 35, 40),
            'SKU-BAT-01': (130, 18, 25),
            'SKU-ENC-01': (190, 20, 30),
            'SKU-HAR-01': (510, 60, 80),
        },
    }

    sku_dict = {item[0]: item for item in skus_catalog}

    for wh_code, wh_obj in warehouse_map.items():
        for sku_id, (qty, res, reorder) in inventory_spec[wh_code].items():
            inv = Inventory.query.filter_by(warehouse_id=wh_obj.id, sku=sku_id).first()
            if not inv:
                sku_info = sku_dict[sku_id]
                inv = Inventory(
                    warehouse_id=wh_obj.id,
                    sku=sku_id,
                    item_name=sku_info[1],
                    category=sku_info[2],
                    quantity=qty,
                    reserved_quantity=res,
                    reorder_point=reorder,
                    unit_cost=sku_info[3],
                )
                db.session.add(inv)
                summary['inventories'] += 1

    db.session.flush()

    # =========================================================================
    # 4. Twelve Realistic Shipments with Cargo Items
    # =========================================================================
    shipments_data = [
        # Scenario A Anchor Shipment: SHP-2026-003 is Delayed by 96h, carrying 500x SKU-MCU-01
        {
            'tracking_number': 'SHP-2026-003',
            'supplier_code': 'SUP-PACIFIC',
            'origin_city': 'Hsinchu, Taiwan',
            'destination_wh': 'WH-WEST',
            'carrier': 'Pacific Seaways',
            'transport_mode': 'Ocean',
            'status': 'Delayed',
            'est_dep': now - timedelta(days=12),
            'act_dep': now - timedelta(days=12),
            'est_arr': now + timedelta(days=4),   # Pushed back 4 days
            'act_arr': None,
            'items': [('SKU-MCU-01', 'Cortex-M4 Industrial Microcontroller', 500)]
        },
        {
            'tracking_number': 'SHP-2026-001',
            'supplier_code': 'SUP-PACIFIC',
            'origin_city': 'Taipei, Taiwan',
            'destination_wh': 'WH-CENTRAL',
            'carrier': 'Singapore Cargo Airlines',
            'transport_mode': 'Air',
            'status': 'In Transit',
            'est_dep': now - timedelta(days=2),
            'act_dep': now - timedelta(days=2),
            'est_arr': now + timedelta(days=2),
            'act_arr': None,
            'items': [('SKU-MCU-02', 'Dual-Core DSP Signal Processor', 400)]
        },
        {
            'tracking_number': 'SHP-2026-002',
            'supplier_code': 'SUP-APEX',
            'origin_city': 'Stuttgart, Germany',
            'destination_wh': 'WH-EAST',
            'carrier': 'Hapag-Lloyd Ocean',
            'transport_mode': 'Ocean',
            'status': 'In Transit',
            'est_dep': now - timedelta(days=8),
            'act_dep': now - timedelta(days=8),
            'est_arr': now + timedelta(days=5),
            'act_arr': None,
            'items': [('SKU-ACT-01', 'High-Torque Brushless Servo Actuator', 250)]
        },
        {
            'tracking_number': 'SHP-2026-004',
            'supplier_code': 'SUP-EUROTRANS',
            'origin_city': 'Rotterdam, Netherlands',
            'destination_wh': 'WH-EAST',
            'carrier': 'DHL Freight Europe',
            'transport_mode': 'Road',
            'status': 'Scheduled',
            'est_dep': now + timedelta(days=2),
            'act_dep': None,
            'est_arr': now + timedelta(days=4),
            'act_arr': None,
            'items': [('SKU-ENC-01', 'IP67 Sealed Aluminum Enclosure', 150)]
        },
        {
            'tracking_number': 'SHP-2026-005',
            'supplier_code': 'SUP-NORDIC',
            'origin_city': 'Gothenburg, Sweden',
            'destination_wh': 'WH-EAST',
            'carrier': 'SAS Cargo Group',
            'transport_mode': 'Air',
            'status': 'Delivered',
            'est_dep': now - timedelta(days=5),
            'act_dep': now - timedelta(days=5),
            'est_arr': now - timedelta(days=1),
            'act_arr': now - timedelta(days=1),
            'items': [('SKU-SNS-01', '6-Axis Inertial IMU Sensor', 600)]
        },
        {
            'tracking_number': 'SHP-2026-006',
            'supplier_code': 'SUP-EUROTRANS',
            'origin_city': 'Duisburg, Germany',
            'destination_wh': 'WH-EAST',
            'carrier': 'DB Schenker Rail',
            'transport_mode': 'Rail',
            'status': 'In Transit',
            'est_dep': now - timedelta(days=3),
            'act_dep': now - timedelta(days=3),
            'est_arr': now + timedelta(days=1),
            'act_arr': None,
            'items': [('SKU-HAR-01', 'Mil-Spec Braided Wiring Harness', 300)]
        },
        {
            'tracking_number': 'SHP-2026-007',
            'supplier_code': 'SUP-SINGACHIP',
            'origin_city': 'Singapore, Jurong',
            'destination_wh': 'WH-WEST',
            'carrier': 'FedEx Express Worldwide',
            'transport_mode': 'Air',
            'status': 'Scheduled',
            'est_dep': now + timedelta(days=1),
            'act_dep': None,
            'est_arr': now + timedelta(days=3),
            'act_arr': None,
            'items': [('SKU-PWR-01', '48V/10A Industrial Power Module', 150)]
        },
        {
            'tracking_number': 'SHP-2026-008',
            'supplier_code': 'SUP-APEX',
            'origin_city': 'Nuremberg, Germany',
            'destination_wh': 'WH-EAST',
            'carrier': 'Kuehne+Nagel Intermodal',
            'transport_mode': 'Road',
            'status': 'Delivered',
            'est_dep': now - timedelta(days=6),
            'act_dep': now - timedelta(days=6),
            'est_arr': now - timedelta(days=2),
            'act_arr': now - timedelta(days=2),
            'items': [('SKU-ACT-02', 'Precision Stepper Motor Driver', 200)]
        },
        {
            'tracking_number': 'SHP-2026-009',
            'supplier_code': 'SUP-SINGACHIP',
            'origin_city': 'Singapore Port',
            'destination_wh': 'WH-EAST',
            'carrier': 'ONE Ocean Network',
            'transport_mode': 'Ocean',
            'status': 'In Transit',
            'est_dep': now - timedelta(days=10),
            'act_dep': now - timedelta(days=10),
            'est_arr': now + timedelta(days=6),
            'act_arr': None,
            'items': [('SKU-BAT-01', '24V 50Ah LiFePO4 Battery Unit', 100)]
        },
        {
            'tracking_number': 'SHP-2026-010',
            'supplier_code': 'SUP-NORDIC',
            'origin_city': 'Stockholm, Sweden',
            'destination_wh': 'WH-WEST',
            'carrier': 'Polaris Air Cargo',
            'transport_mode': 'Air',
            'status': 'In Transit',
            'est_dep': now - timedelta(days=1),
            'act_dep': now - timedelta(days=1),
            'est_arr': now + timedelta(days=2),
            'act_arr': None,
            'items': [('SKU-SNS-01', '6-Axis Inertial IMU Sensor', 350)]
        },
        {
            'tracking_number': 'SHP-2026-011',
            'supplier_code': 'SUP-PACIFIC',
            'origin_city': 'Kaohsiung, Taiwan',
            'destination_wh': 'WH-EAST',
            'carrier': 'Evergreen Marine Line',
            'transport_mode': 'Ocean',
            'status': 'Scheduled',
            'est_dep': now + timedelta(days=5),
            'act_dep': None,
            'est_arr': now + timedelta(days=25),
            'act_arr': None,
            'items': [('SKU-MCU-01', 'Cortex-M4 Industrial Microcontroller', 500)]
        },
        {
            'tracking_number': 'SHP-2026-012',
            'supplier_code': 'SUP-EUROTRANS',
            'origin_city': 'Amsterdam Airport',
            'destination_wh': 'WH-CENTRAL',
            'carrier': 'KLM Cargo Worldwide',
            'transport_mode': 'Air',
            'status': 'Delivered',
            'est_dep': now - timedelta(days=4),
            'act_dep': now - timedelta(days=4),
            'est_arr': now - timedelta(days=1),
            'act_arr': now - timedelta(days=1),
            'items': [('SKU-ENC-01', 'IP67 Sealed Aluminum Enclosure', 200)]
        },
    ]

    shipment_map = {}
    for shp_info in shipments_data:
        shp = Shipment.query.filter_by(tracking_number=shp_info['tracking_number']).first()
        if not shp:
            sup = supplier_map[shp_info['supplier_code']]
            dest_wh = warehouse_map[shp_info['destination_wh']]
            shp = Shipment(
                tracking_number=shp_info['tracking_number'],
                supplier_id=sup.id,
                destination_warehouse_id=dest_wh.id,
                carrier=shp_info['carrier'],
                transport_mode=shp_info['transport_mode'],
                status=shp_info['status'],
                origin_city=shp_info['origin_city'],
                destination_city=dest_wh.location,
                estimated_departure=shp_info['est_dep'],
                actual_departure=shp_info['act_dep'],
                estimated_arrival=shp_info['est_arr'],
                actual_arrival=shp_info['act_arr'],
            )
            db.session.add(shp)
            db.session.flush()
            summary['shipments'] += 1

            for item_sku, item_name, item_qty in shp_info['items']:
                s_item = ShipmentItem(
                    shipment_id=shp.id,
                    sku=item_sku,
                    item_name=item_name,
                    quantity=item_qty
                )
                db.session.add(s_item)

        shipment_map[shp_info['tracking_number']] = shp

    db.session.flush()

    # =========================================================================
    # 5. Twenty-Five Customer Orders with Realistic Scenarios A & B
    # =========================================================================
    orders_data = [
        # --- Scenario A Anchor Orders (Needing SKU-MCU-01 at WH-WEST impacted by SHP-2026-003 delay) ---
        {
            'order_number': 'ORD-2026-004',
            'customer_name': 'Tesla Gigafactory Europe',
            'customer_tier': 'Platinum',
            'status': 'At Risk',
            'priority': 'Critical',
            'dest_wh': 'WH-WEST',
            'deadline_days': 2,
            'items': [
                ('SKU-MCU-01', 80, 28.50),
                ('SKU-PWR-01', 40, 68.00),
            ]
        },
        {
            'order_number': 'ORD-2026-007',
            'customer_name': 'Honeywell Aerospace Systems',
            'customer_tier': 'Gold',
            'status': 'At Risk',
            'priority': 'High',
            'dest_wh': 'WH-WEST',
            'deadline_days': 3,
            'items': [
                ('SKU-MCU-01', 60, 28.50),
                ('SKU-SNS-01', 50, 16.80),
            ]
        },
        {
            'order_number': 'ORD-2026-015',
            'customer_name': 'ABB Robotics Automation',
            'customer_tier': 'Platinum',
            'status': 'At Risk',
            'priority': 'Critical',
            'dest_wh': 'WH-WEST',
            'deadline_days': 3,
            'items': [
                ('SKU-MCU-01', 110, 28.50),
                ('SKU-ACT-01', 20, 115.00),
            ]
        },

        # --- Scenario B Anchor Order (Needing SKU-SNS-02 at WH-EAST where local stock is depleted) ---
        {
            'order_number': 'ORD-2026-012',
            'customer_name': 'Siemens Healthineers Ultrasound',
            'customer_tier': 'Platinum',
            'status': 'At Risk',
            'priority': 'Critical',
            'dest_wh': 'WH-EAST',
            'deadline_days': 2,
            'items': [
                ('SKU-SNS-02', 120, 22.40),   # Only 5 available in WH-EAST! Confirmed shortage!
                ('SKU-ENC-01', 30, 54.00),
            ]
        },

        # --- Remaining 21 Diverse Logistics Customer Orders ---
        {
            'order_number': 'ORD-2026-001',
            'customer_name': 'Bosch Mobility Solutions',
            'customer_tier': 'Platinum',
            'status': 'Allocated',
            'priority': 'High',
            'dest_wh': 'WH-EAST',
            'deadline_days': 5,
            'items': [('SKU-SNS-01', 50, 16.80), ('SKU-HAR-01', 40, 19.50)]
        },
        {
            'order_number': 'ORD-2026-002',
            'customer_name': 'Vestas Wind Energy Systems',
            'customer_tier': 'Gold',
            'status': 'Pending',
            'priority': 'Medium',
            'dest_wh': 'WH-EAST',
            'deadline_days': 7,
            'items': [('SKU-ACT-01', 15, 115.00), ('SKU-PWR-01', 20, 68.00)]
        },
        {
            'order_number': 'ORD-2026-003',
            'customer_name': 'Schneider Electric Energy',
            'customer_tier': 'Gold',
            'status': 'Shipped',
            'priority': 'Medium',
            'dest_wh': 'WH-CENTRAL',
            'deadline_days': 4,
            'items': [('SKU-PWR-01', 35, 68.00), ('SKU-BAT-01', 10, 320.00)]
        },
        {
            'order_number': 'ORD-2026-005',
            'customer_name': 'ASML Lithography Instruments',
            'customer_tier': 'Platinum',
            'status': 'Allocated',
            'priority': 'Critical',
            'dest_wh': 'WH-EAST',
            'deadline_days': 6,
            'items': [('SKU-MCU-02', 20, 45.00), ('SKU-SNS-01', 30, 16.80)]
        },
        {
            'order_number': 'ORD-2026-006',
            'customer_name': 'Volvo Autonomous Solutions',
            'customer_tier': 'Gold',
            'status': 'Pending',
            'priority': 'Medium',
            'dest_wh': 'WH-WEST',
            'deadline_days': 8,
            'items': [('SKU-ACT-02', 25, 34.00), ('SKU-HAR-01', 30, 19.50)]
        },
        {
            'order_number': 'ORD-2026-008',
            'customer_name': 'Philips Precision Medical',
            'customer_tier': 'Platinum',
            'status': 'Allocated',
            'priority': 'High',
            'dest_wh': 'WH-CENTRAL',
            'deadline_days': 5,
            'items': [('SKU-MCU-02', 40, 45.00), ('SKU-SNS-02', 25, 22.40)]
        },
        {
            'order_number': 'ORD-2026-009',
            'customer_name': 'KUKA Industrial Robotics',
            'customer_tier': 'Standard',
            'status': 'Pending',
            'priority': 'Low',
            'dest_wh': 'WH-EAST',
            'deadline_days': 12,
            'items': [('SKU-ACT-01', 10, 115.00), ('SKU-ENC-01', 20, 54.00)]
        },
        {
            'order_number': 'ORD-2026-010',
            'customer_name': 'Caterpillar Autonomous Haulage',
            'customer_tier': 'Gold',
            'status': 'Allocated',
            'priority': 'Medium',
            'dest_wh': 'WH-WEST',
            'deadline_days': 9,
            'items': [('SKU-BAT-01', 8, 320.00), ('SKU-PWR-01', 15, 68.00)]
        },
        {
            'order_number': 'ORD-2026-011',
            'customer_name': 'Alstom Transport Systems',
            'customer_tier': 'Standard',
            'status': 'Pending',
            'priority': 'Low',
            'dest_wh': 'WH-EAST',
            'deadline_days': 14,
            'items': [('SKU-HAR-01', 60, 19.50), ('SKU-ENC-01', 25, 54.00)]
        },
        {
            'order_number': 'ORD-2026-013',
            'customer_name': 'Maersk Logistics Digital Fleet',
            'customer_tier': 'Platinum',
            'status': 'Allocated',
            'priority': 'High',
            'dest_wh': 'WH-CENTRAL',
            'deadline_days': 4,
            'items': [('SKU-SNS-01', 40, 16.80), ('SKU-BAT-01', 12, 320.00)]
        },
        {
            'order_number': 'ORD-2026-014',
            'customer_name': 'General Electric Grid Solutions',
            'customer_tier': 'Gold',
            'status': 'Pending',
            'priority': 'Medium',
            'dest_wh': 'WH-WEST',
            'deadline_days': 10,
            'items': [('SKU-PWR-01', 20, 68.00), ('SKU-ENC-01', 30, 54.00)]
        },
        {
            'order_number': 'ORD-2026-016',
            'customer_name': 'Hitachi Rail Global',
            'customer_tier': 'Standard',
            'status': 'Shipped',
            'priority': 'Low',
            'dest_wh': 'WH-CENTRAL',
            'deadline_days': 8,
            'items': [('SKU-HAR-01', 50, 19.50)]
        },
        {
            'order_number': 'ORD-2026-017',
            'customer_name': 'Rockwell Factory Automation',
            'customer_tier': 'Gold',
            'status': 'Pending',
            'priority': 'Medium',
            'dest_wh': 'WH-WEST',
            'deadline_days': 11,
            'items': [('SKU-ACT-02', 20, 34.00), ('SKU-MCU-02', 15, 45.00)]
        },
        {
            'order_number': 'ORD-2026-018',
            'customer_name': 'STMicroelectronics Packaging',
            'customer_tier': 'Standard',
            'status': 'Pending',
            'priority': 'Low',
            'dest_wh': 'WH-CENTRAL',
            'deadline_days': 15,
            'items': [('SKU-ENC-01', 15, 54.00)]
        },
        {
            'order_number': 'ORD-2026-019',
            'customer_name': 'Continental Automotive Telematic',
            'customer_tier': 'Gold',
            'status': 'Allocated',
            'priority': 'High',
            'dest_wh': 'WH-EAST',
            'deadline_days': 5,
            'items': [('SKU-SNS-01', 35, 16.80), ('SKU-ACT-02', 20, 34.00)]
        },
        {
            'order_number': 'ORD-2026-020',
            'customer_name': 'ZF Friedrichshafen Mobility',
            'customer_tier': 'Standard',
            'status': 'Pending',
            'priority': 'Low',
            'dest_wh': 'WH-EAST',
            'deadline_days': 16,
            'items': [('SKU-HAR-01', 40, 19.50)]
        },
        {
            'order_number': 'ORD-2026-021',
            'customer_name': 'Panasonic Energy Storage',
            'customer_tier': 'Platinum',
            'status': 'Allocated',
            'priority': 'Critical',
            'dest_wh': 'WH-CENTRAL',
            'deadline_days': 3,
            'items': [('SKU-BAT-01', 15, 320.00), ('SKU-PWR-01', 25, 68.00)]
        },
        {
            'order_number': 'ORD-2026-022',
            'customer_name': 'Emerson Process Management',
            'customer_tier': 'Gold',
            'status': 'Pending',
            'priority': 'Medium',
            'dest_wh': 'WH-WEST',
            'deadline_days': 9,
            'items': [('SKU-SNS-01', 25, 16.80), ('SKU-ENC-01', 20, 54.00)]
        },
        {
            'order_number': 'ORD-2026-023',
            'customer_name': 'Danfoss Drives & Inverters',
            'customer_tier': 'Standard',
            'status': 'Pending',
            'priority': 'Low',
            'dest_wh': 'WH-EAST',
            'deadline_days': 13,
            'items': [('SKU-ACT-02', 15, 34.00)]
        },
        {
            'order_number': 'ORD-2026-024',
            'customer_name': 'Daikin Applied HVAC Controls',
            'customer_tier': 'Standard',
            'status': 'Delivered',
            'priority': 'Low',
            'dest_wh': 'WH-CENTRAL',
            'deadline_days': 1,
            'items': [('SKU-HAR-01', 25, 19.50)]
        },
        {
            'order_number': 'ORD-2026-025',
            'customer_name': 'Lockheed Maritime Sensor Wing',
            'customer_tier': 'Platinum',
            'status': 'Allocated',
            'priority': 'Critical',
            'dest_wh': 'WH-WEST',
            'deadline_days': 4,
            'items': [('SKU-MCU-02', 30, 45.00), ('SKU-PWR-01', 20, 68.00)]
        },
    ]

    order_map = {}
    for ord_info in orders_data:
        co = CustomerOrder.query.filter_by(order_number=ord_info['order_number']).first()
        if not co:
            target_wh = warehouse_map[ord_info['dest_wh']]
            total_val = sum(q * p for _, q, p in ord_info['items'])
            
            co = CustomerOrder(
                order_number=ord_info['order_number'],
                customer_name=ord_info['customer_name'],
                customer_tier=ord_info['customer_tier'],
                status=ord_info['status'],
                priority=ord_info['priority'],
                total_value=round(total_val, 2),
                assigned_warehouse_id=target_wh.id,
                order_date=now - timedelta(days=2),
                delivery_deadline=now + timedelta(days=ord_info['deadline_days']),
            )
            db.session.add(co)
            db.session.flush()
            summary['orders'] += 1

            for sku_code, qty, price in ord_info['items']:
                item_name = sku_dict[sku_code][1]
                oi = OrderItem(
                    order_id=co.id,
                    sku=sku_code,
                    item_name=item_name,
                    quantity=qty,
                    unit_price=price,
                )
                db.session.add(oi)

        order_map[ord_info['order_number']] = co

    db.session.flush()

    # =========================================================================
    # 6. Seed Clearly Documented Scenarios A & B Disruption Records
    # =========================================================================
    # Scenario A: Delayed Shipment SHP-2026-003 carrying SKU-MCU-01
    dis_a = Disruption.query.filter_by(disruption_code='DIS-2026-001').first()
    if not dis_a:
        delayed_shp = shipment_map.get('SHP-2026-003')
        dis_a = Disruption(
            disruption_code='DIS-2026-001',
            title='Port of Long Beach Berthing Delay — Pacific Seaways (SHP-2026-003)',
            disruption_type='Port Congestion',
            severity='Critical',
            status='Active',
            shortage_category='Potential Shortage',
            shipment_id=delayed_shp.id if delayed_shp else None,
            warehouse_id=warehouse_map['WH-WEST'].id,
            location='Port of Long Beach - Anchorage Berth 4',
            description=(
                'Severe container terminal berth backlog and coastal fog at Port of Long Beach has delayed '
                'vessel Pacific Seaways by 96 hours. Shipment carries 500 units of Cortex-M4 Industrial Microcontrollers (SKU-MCU-01) '
                'bound for WH-WEST. Available stock at WH-WEST is only 10 units vs 250 units required by high-priority customer orders.'
            ),
            estimated_delay_hours=96,
            detected_at=now - timedelta(hours=6),
        )
        db.session.add(dis_a)
        db.session.flush()

        # Link affected customer orders for Scenario A
        for ord_num in ['ORD-2026-004', 'ORD-2026-007', 'ORD-2026-015']:
            if ord_num in order_map:
                dis_a.affected_orders.append(order_map[ord_num])

        summary['disruptions'] += 1

    # Scenario B: Warehouse Stockout at WH-EAST for SKU-SNS-02
    dis_b = Disruption.query.filter_by(disruption_code='DIS-2026-002').first()
    if not dis_b:
        wh_east = warehouse_map['WH-EAST']
        dis_b = Disruption(
            disruption_code='DIS-2026-002',
            title='Rotterdam Eurohub Stockout — SKU-SNS-02 Environmental Optical Sensors',
            disruption_type='Warehouse Stockout',
            severity='High',
            status='Active',
            shortage_category='Confirmed Shortage',
            shipment_id=None,
            warehouse_id=wh_east.id,
            location='WH-EAST Rotterdam Eurohub',
            description=(
                'Critical stock depletion at WH-EAST: only 5 available units of SKU-SNS-02 remain against '
                'a high-priority order requirement of 120 units for Siemens Healthineers (ORD-2026-012). '
                'Surplus buffer inventory (300 available units) is currently verified at WH-CENTRAL (Singapore) for potential transfer.'
            ),
            estimated_delay_hours=48,
            detected_at=now - timedelta(hours=14),
        )
        db.session.add(dis_b)
        db.session.flush()

        # Link affected customer order for Scenario B
        if 'ORD-2026-012' in order_map:
            dis_b.affected_orders.append(order_map['ORD-2026-012'])

        summary['disruptions'] += 1

    # Record Audit Log
    if any(summary.values()):
        audit = AuditLog(
            action='SEED_LOGISTICS_DATA',
            entity_type='System',
            entity_id='DemoDataset',
            details=f"Seeded logistics dataset: {summary}",
        )
        db.session.add(audit)

    db.session.commit()
    return summary
