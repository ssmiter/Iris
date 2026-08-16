PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- 脱敏工业能力样例。所有标识、口径与数值均为 Iris 构造的模拟数据，
-- 只用于验证“域 → 工序 → 业务对象 → 能力”的发现与组合。
CREATE TABLE IF NOT EXISTS industrial_demo_material_stock (
    domain_code TEXT NOT NULL,
    material_code TEXT NOT NULL,
    material_name TEXT NOT NULL,
    material_category TEXT NOT NULL,
    warehouse_code TEXT NOT NULL,
    available_quantity REAL NOT NULL,
    reserved_quantity REAL NOT NULL,
    safety_stock REAL NOT NULL,
    unit TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (domain_code, material_code, warehouse_code)
);

CREATE TABLE IF NOT EXISTS industrial_demo_production_plan (
    domain_code TEXT NOT NULL,
    plan_no TEXT NOT NULL,
    process_code TEXT NOT NULL,
    plan_date TEXT NOT NULL,
    equipment_code TEXT NOT NULL,
    material_code TEXT NOT NULL,
    material_name TEXT NOT NULL,
    planned_batches INTEGER NOT NULL,
    completed_batches INTEGER NOT NULL,
    planned_weight REAL NOT NULL,
    actual_weight REAL NOT NULL,
    shift_code TEXT NOT NULL,
    priority TEXT NOT NULL,
    status TEXT NOT NULL,
    PRIMARY KEY (domain_code, plan_no)
);

CREATE TABLE IF NOT EXISTS industrial_demo_equipment_state (
    domain_code TEXT NOT NULL,
    equipment_code TEXT NOT NULL,
    equipment_name TEXT NOT NULL,
    process_code TEXT NOT NULL,
    workshop_code TEXT NOT NULL,
    state TEXT NOT NULL,
    utilization_percent REAL NOT NULL,
    current_plan_no TEXT,
    latest_alarm TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (domain_code, equipment_code)
);

CREATE TABLE IF NOT EXISTS industrial_demo_equipment_event (
    domain_code TEXT NOT NULL,
    event_no TEXT NOT NULL,
    equipment_code TEXT NOT NULL,
    event_type TEXT NOT NULL,
    severity TEXT NOT NULL,
    reason_category TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    resolution_state TEXT NOT NULL,
    PRIMARY KEY (domain_code, event_no)
);

CREATE TABLE IF NOT EXISTS industrial_demo_quality_measurement (
    domain_code TEXT NOT NULL,
    sample_no TEXT NOT NULL,
    batch_no TEXT NOT NULL,
    material_code TEXT NOT NULL,
    equipment_code TEXT NOT NULL,
    metric_code TEXT NOT NULL,
    measured_value REAL NOT NULL,
    lower_limit REAL NOT NULL,
    upper_limit REAL NOT NULL,
    judge_result TEXT NOT NULL,
    sampled_at TEXT NOT NULL,
    PRIMARY KEY (domain_code, sample_no, metric_code)
);

CREATE TABLE IF NOT EXISTS industrial_demo_process_record (
    domain_code TEXT NOT NULL,
    process_code TEXT NOT NULL,
    record_type TEXT NOT NULL,
    record_no TEXT NOT NULL,
    business_date TEXT NOT NULL,
    item_code TEXT NOT NULL,
    item_name TEXT NOT NULL,
    resource_code TEXT,
    status TEXT NOT NULL,
    planned_quantity REAL,
    actual_quantity REAL,
    unit TEXT,
    priority TEXT,
    detail_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (domain_code, process_code, record_type, record_no)
);

CREATE TABLE IF NOT EXISTS industrial_demo_reference_object (
    domain_code TEXT NOT NULL,
    object_type TEXT NOT NULL,
    object_code TEXT NOT NULL,
    object_name TEXT NOT NULL,
    process_code TEXT NOT NULL,
    version TEXT,
    status TEXT NOT NULL,
    resource_code TEXT,
    detail_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (domain_code, object_type, object_code)
);

INSERT OR IGNORE INTO industrial_demo_material_stock VALUES
('mes','MAT-A101','通用合成原料 A','polymer','WH-RAW-01',12800,2100,5000,'kg','2026-07-29T08:30:00Z'),
('mes','MAT-B205','通用填充材料 B','filler','WH-RAW-01',3600,900,4200,'kg','2026-07-29T08:32:00Z'),
('mes','MAT-C310','通用助剂 C','additive','WH-RAW-02',760,120,500,'kg','2026-07-29T08:35:00Z'),
('mes','MAT-D420','通用增强材料 D','reinforcement','WH-RAW-03',9400,1800,6000,'kg','2026-07-29T08:37:00Z');

INSERT OR IGNORE INTO industrial_demo_production_plan VALUES
('mes','MES-PLAN-0729-01','mixing','2026-07-29','MX-01','CMP-A01','通用胶料 A',24,18,19200,14450,'day','normal','running'),
('mes','MES-PLAN-0729-02','mixing','2026-07-29','MX-02','CMP-B02','通用胶料 B',20,20,15000,15080,'day','high','completed'),
('mes','MES-PLAN-0730-01','mixing','2026-07-30','MX-01','CMP-C03','通用胶料 C',16,0,11200,0,'night','normal','scheduled'),
('mes','MES-PLAN-0729-03','mixing','2026-07-29','MX-03','CMP-C11','通用胶料 C11',18,11,12600,7710,'day','high','running'),
('mes','MES-PLAN-0729-04','mixing','2026-07-29','MX-04','CMP-C12','通用胶料 C12',14,14,9800,9840,'night','normal','completed'),
('mes','MES-PLAN-0730-02','mixing','2026-07-30','MX-03','CMP-C13','通用胶料 C13',12,0,8400,0,'day','normal','scheduled');

INSERT OR IGNORE INTO industrial_demo_equipment_state VALUES
('mes','MX-01','一号密炼单元','mixing','WS-MIX','running',82.4,'MES-PLAN-0729-01',NULL,'2026-07-29T09:10:00Z'),
('mes','MX-02','二号密炼单元','mixing','WS-MIX','idle',68.1,NULL,NULL,'2026-07-29T09:08:00Z'),
('mes','FM-01','一号成型单元','forming','WS-FORM','warning',74.6,NULL,'上料节拍偏慢','2026-07-29T09:09:00Z'),
('mes','CU-01','一号硫化单元','curing','WS-CURE','maintenance',0,NULL,'计划保养','2026-07-29T08:50:00Z'),
('mes','MX-03','三号密炼单元','mixing','WS-MIX','running',79.2,'MES-PLAN-0729-03',NULL,'2026-07-29T09:07:00Z'),
('mes','MX-04','四号密炼单元','mixing','WS-MIX','warning',63.5,NULL,'冷却水温度偏高','2026-07-29T09:06:00Z');

INSERT OR IGNORE INTO industrial_demo_equipment_event VALUES
('mes','EVT-0729-001','MX-04','unplanned_stop','medium','cooling','2026-07-29T06:42:00Z','2026-07-29T07:05:00Z','resolved'),
('mes','EVT-0729-002','MX-03','speed_loss','low','feeding','2026-07-29T08:12:00Z','2026-07-29T08:18:00Z','resolved'),
('mes','EVT-0729-003','MX-04','process_warning','medium','temperature','2026-07-29T09:01:00Z',NULL,'open'),
('mes','EVT-0728-004','MX-03','planned_stop','info','maintenance','2026-07-28T14:00:00Z','2026-07-28T14:35:00Z','resolved');

INSERT OR IGNORE INTO industrial_demo_quality_measurement VALUES
('mes','QS-0729-001','BATCH-C11-017','CMP-C11','MX-03','viscosity',64.2,60,68,'pass','2026-07-29T07:15:00Z'),
('mes','QS-0729-001','BATCH-C11-017','CMP-C11','MX-03','dispersion',7.8,7,9,'pass','2026-07-29T07:15:00Z'),
('mes','QS-0729-002','BATCH-C11-018','CMP-C11','MX-03','viscosity',69.1,60,68,'fail','2026-07-29T07:52:00Z'),
('mes','QS-0729-002','BATCH-C11-018','CMP-C11','MX-03','dispersion',7.4,7,9,'pass','2026-07-29T07:52:00Z'),
('mes','QS-0729-003','BATCH-C12-014','CMP-C12','MX-04','viscosity',62.7,59,67,'pass','2026-07-29T08:26:00Z'),
('mes','QS-0729-003','BATCH-C12-014','CMP-C12','MX-04','dispersion',6.8,7,9,'fail','2026-07-29T08:26:00Z');

INSERT OR IGNORE INTO industrial_demo_process_record VALUES
('mes','semifinished','production','SEMI-PROD-0729-01','2026-07-29','SEMI-A10','通用半制品 A10','SEMI-LINE-01','running',1200,760,'m','normal','{"shift":"day","nextProcess":"forming"}','2026-07-29T09:12:00Z'),
('mes','semifinished','inventory','SEMI-STOCK-0729-01','2026-07-29','SEMI-B20','通用半制品 B20','BUFFER-S01','available',800,635,'m','normal','{"ageHours":5.5,"holdQuantity":40}','2026-07-29T09:05:00Z'),
('mes','forming','plan','FORM-PLAN-0729-01','2026-07-29','PRODUCT-X1','通用制品 X1','FM-01','running',320,188,'piece','high','{"shift":"day","materialReady":true}','2026-07-29T09:10:00Z'),
('mes','forming','production','FORM-PROD-0729-01','2026-07-29','PRODUCT-X2','通用制品 X2','FM-02','completed',240,242,'piece','normal','{"qualifiedQuantity":238,"scrapQuantity":4}','2026-07-29T08:58:00Z'),
('mes','curing','plan','CURE-PLAN-0729-01','2026-07-29','PRODUCT-X1','通用制品 X1','CU-02','scheduled',300,0,'piece','high','{"mouldCode":"MOULD-X1-A","plannedStart":"2026-07-29T10:00:00Z"}','2026-07-29T09:03:00Z'),
('mes','curing','production','CURE-PROD-0729-01','2026-07-29','PRODUCT-X2','通用制品 X2','CU-03','running',260,171,'piece','normal','{"cycleSeconds":720,"qualifiedQuantity":169}','2026-07-29T09:11:00Z'),
('mes','quality','inspection','FQC-0729-001','2026-07-29','PRODUCT-X2','通用制品 X2','FQC-LINE-01','completed',40,40,'piece','normal','{"passed":38,"failed":2,"inspectionType":"appearance"}','2026-07-29T08:55:00Z'),
('mes','quality','exception','QEX-0729-001','2026-07-29','PRODUCT-X1','通用制品 X1','FQC-LINE-02','open',1,1,'case','high','{"defectCategory":"surface","affectedQuantity":6,"disposition":"pending"}','2026-07-29T09:02:00Z'),
('mes','warehouse','inventory','FG-STOCK-0729-01','2026-07-29','PRODUCT-X1','通用制品 X1','WH-FG-01','available',1800,1640,'piece','normal','{"allocatedQuantity":260,"qualityHoldQuantity":20}','2026-07-29T09:06:00Z'),
('mes','warehouse','movement','FG-MOVE-0729-01','2026-07-29','PRODUCT-X2','通用制品 X2','DOCK-02','completed',320,320,'piece','normal','{"direction":"outbound","vehicleSlot":"SLOT-03"}','2026-07-29T08:47:00Z'),
('mes','aps','demand','APS-DEMAND-0730-01','2026-07-30','PRODUCT-X1','通用制品 X1',NULL,'accepted',600,0,'piece','high','{"dueDate":"2026-08-01","source":"demo-order"}','2026-07-29T09:00:00Z'),
('mes','aps','schedule','APS-SCHEDULE-0730-01','2026-07-30','PRODUCT-X1','通用制品 X1','LINE-GROUP-A','feasible',600,600,'piece','high','{"bottleneck":"curing","estimatedCompletion":"2026-07-31T16:00:00Z","demandNo":"DMD-0730-01","plans":[{"equipmentCode":"CU-02","processCode":"curing","planDate":"2026-07-30","shiftCode":"day","plannedBatches":300,"plannedWeight":0}]}','2026-07-29T09:04:00Z');

INSERT OR IGNORE INTO industrial_demo_reference_object VALUES
('mes','recipe','RCP-C11','通用胶料 C11 配方','mixing','3.2','active','MX-03','{"componentCount":7,"approved":true}','2026-07-28T12:00:00Z'),
('mes','recipe','RCP-C12','通用胶料 C12 配方','mixing','2.5','active','MX-04','{"componentCount":8,"approved":true}','2026-07-27T11:00:00Z'),
('mes','mould','MOULD-X1-A','X1 通用模具 A','curing','1','in_use','CU-02','{"ratedCycles":8000,"usedCycles":5240,"maintenanceDueCycles":6000}','2026-07-29T08:40:00Z'),
('mes','mould','MOULD-X2-B','X2 通用模具 B','curing','1','available','MOULD-RACK-02','{"ratedCycles":7500,"usedCycles":3190,"maintenanceDueCycles":5000}','2026-07-29T08:42:00Z');

-- ── 全景扩充（docs/27）：链头需求、批次谱系、原料流转、质量异常闭环四张新表，
--    以及既有表演示种子的跨表自洽扩充。所有记录仍为 Iris 构造的脱敏模拟数据。

CREATE TABLE IF NOT EXISTS industrial_demo_demand_order (
    domain_code TEXT NOT NULL,
    demand_no TEXT NOT NULL,
    item_code TEXT NOT NULL,
    item_name TEXT NOT NULL,
    quantity REAL NOT NULL,
    unit TEXT NOT NULL,
    due_date TEXT NOT NULL,
    priority TEXT NOT NULL,
    state TEXT NOT NULL,
    source TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (domain_code, demand_no)
);

CREATE TABLE IF NOT EXISTS industrial_demo_batch (
    domain_code TEXT NOT NULL,
    batch_no TEXT NOT NULL,
    item_code TEXT NOT NULL,
    item_name TEXT NOT NULL,
    plan_no TEXT NOT NULL,
    equipment_code TEXT NOT NULL,
    process_code TEXT NOT NULL,
    produced_at TEXT NOT NULL,
    quantity REAL NOT NULL,
    unit TEXT NOT NULL,
    quality_state TEXT NOT NULL,
    downstream_ref TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (domain_code, batch_no)
);

CREATE TABLE IF NOT EXISTS industrial_demo_material_movement (
    domain_code TEXT NOT NULL,
    movement_no TEXT NOT NULL,
    material_code TEXT NOT NULL,
    material_name TEXT NOT NULL,
    movement_type TEXT NOT NULL,
    quantity REAL NOT NULL,
    unit TEXT NOT NULL,
    warehouse_code TEXT NOT NULL,
    related_no TEXT,
    occurred_at TEXT NOT NULL,
    PRIMARY KEY (domain_code, movement_no)
);

CREATE TABLE IF NOT EXISTS industrial_demo_quality_exception (
    domain_code TEXT NOT NULL,
    exception_no TEXT NOT NULL,
    item_code TEXT NOT NULL,
    item_name TEXT NOT NULL,
    source_record_no TEXT,
    defect_category TEXT NOT NULL,
    affected_quantity REAL NOT NULL,
    status TEXT NOT NULL,
    disposition TEXT NOT NULL,
    version INTEGER NOT NULL,
    opened_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (domain_code, exception_no)
);

-- 需求订单：链头。DMD-0728-01 已完成（对应 SHIP-0729-01 发运 320 件 X2）；
-- DMD-0730-01 已排产（对应 APS-DEMAND-0730-01 / APS-MP-0730-01）。
INSERT OR IGNORE INTO industrial_demo_demand_order VALUES
('mes','DMD-0728-01','PRODUCT-X2','通用制品 X2',320,'piece','2026-07-29','normal','completed','customer','2026-07-29T08:50:00Z'),
('mes','DMD-0729-01','PRODUCT-X1','通用制品 X1',300,'piece','2026-07-31','high','released','customer','2026-07-29T09:20:00Z'),
('mes','DMD-0730-01','PRODUCT-X1','通用制品 X1',600,'piece','2026-08-01','high','scheduled','customer','2026-07-30T08:10:00Z'),
('mes','DMD-0730-02','PRODUCT-X2','通用制品 X2',400,'piece','2026-08-03','normal','unscheduled','forecast','2026-07-30T08:12:00Z');

-- 批次谱系：既有质检批号全部入档；018 快检不合格、009 待检。
INSERT OR IGNORE INTO industrial_demo_batch VALUES
('mes','BATCH-C11-017','CMP-C11','通用胶料 C11','MES-PLAN-0729-03','MX-03','mixing','2026-07-29T06:58:00Z',700,'kg','pass','SEMI-PROD-0729-01','2026-07-29T07:20:00Z'),
('mes','BATCH-C11-018','CMP-C11','通用胶料 C11','MES-PLAN-0729-03','MX-03','mixing','2026-07-29T07:40:00Z',700,'kg','fail',NULL,'2026-07-29T07:55:00Z'),
('mes','BATCH-C12-014','CMP-C12','通用胶料 C12','MES-PLAN-0729-04','MX-04','mixing','2026-07-29T08:10:00Z',700,'kg','pass','SEMI-STOCK-0729-01','2026-07-29T08:30:00Z'),
('mes','BATCH-A01-009','CMP-A01','通用胶料 A','MES-PLAN-0729-01','MX-01','mixing','2026-07-29T08:40:00Z',800,'kg','pending',NULL,'2026-07-29T08:45:00Z');

-- 原料收发存：入库补货 → 按批次领出 → 余料退回。
INSERT OR IGNORE INTO industrial_demo_material_movement VALUES
('mes','MM-0728-001','MAT-A101','通用合成原料 A','receipt',5000,'kg','WH-RAW-01','PO-0728-01','2026-07-28T08:00:00Z'),
('mes','MM-0728-002','MAT-B205','通用填充材料 B','receipt',2000,'kg','WH-RAW-01','PO-0728-01','2026-07-28T08:05:00Z'),
('mes','MM-0729-001','MAT-A101','通用合成原料 A','issue',520,'kg','WH-RAW-01','BATCH-C11-017','2026-07-29T06:30:00Z'),
('mes','MM-0729-002','MAT-B205','通用填充材料 B','issue',180,'kg','WH-RAW-01','BATCH-C11-017','2026-07-29T06:31:00Z'),
('mes','MM-0729-003','MAT-A101','通用合成原料 A','issue',520,'kg','WH-RAW-01','BATCH-C11-018','2026-07-29T07:20:00Z'),
('mes','MM-0729-004','MAT-C310','通用助剂 C','return',25,'kg','WH-RAW-02','BATCH-C12-014','2026-07-29T08:20:00Z');

-- 质量异常：一开一闭，演示处置闭环（version 为乐观锁）。
INSERT OR IGNORE INTO industrial_demo_quality_exception VALUES
('mes','QEX-0729-001','PRODUCT-X1','通用制品 X1','FQC-0729-001','surface',6,'open','none',1,'2026-07-29T09:02:00Z','2026-07-29T09:02:00Z'),
('mes','QEX-0729-002','CMP-C11','通用胶料 C11','QS-0729-002','viscosity',700,'open','none',1,'2026-07-29T07:55:00Z','2026-07-29T07:55:00Z'),
('mes','QEX-0728-002','PRODUCT-X2','通用制品 X2','FQC-0728-006','appearance',3,'disposed','concession',2,'2026-07-28T15:00:00Z','2026-07-28T18:30:00Z');

-- process_record 扩充：来料检验 / 投料消耗 / 在制品 / 发运 / 点检维护 / 换模计划 / AP 主计划 / 产能负荷。
INSERT OR IGNORE INTO industrial_demo_process_record VALUES
('mes','raw','inspection','RIQ-0728-001','2026-07-28','MAT-A101','通用合成原料 A','INSP-RAW-01','completed',5000,5000,'kg','normal','{"sampleNo":"RS-0728-001","verdict":"pass","metrics":[{"code":"mooney","value":52,"lower":45,"upper":60,"result":"pass"},{"code":"ash","value":0.4,"lower":0,"upper":0.6,"result":"pass"}]}','2026-07-28T09:10:00Z'),
('mes','raw','inspection','RIQ-0729-001','2026-07-29','MAT-D420','通用增强材料 D','INSP-RAW-01','hold',2000,2000,'kg','high','{"sampleNo":"RS-0729-001","verdict":"fail","metrics":[{"code":"tensile","value":17.8,"lower":18.5,"upper":24,"result":"fail"}],"holdQuantity":2000}','2026-07-29T09:25:00Z'),
('mes','mixing','consumption','CONS-0729-001','2026-07-29','CMP-C11','通用胶料 C11','MX-03','completed',700,702,'kg','normal','{"planNo":"MES-PLAN-0729-03","batchNo":"BATCH-C11-017","components":[{"materialCode":"MAT-A101","quantity":520},{"materialCode":"MAT-B205","quantity":180}]}','2026-07-29T07:00:00Z'),
('mes','mixing','consumption','CONS-0729-002','2026-07-29','CMP-C11','通用胶料 C11','MX-03','completed',700,698,'kg','normal','{"planNo":"MES-PLAN-0729-03","batchNo":"BATCH-C11-018","components":[{"materialCode":"MAT-A101","quantity":520},{"materialCode":"MAT-B205","quantity":180}]}','2026-07-29T07:42:00Z'),
('mes','mixing','consumption','CONS-0729-003','2026-07-29','CMP-C12','通用胶料 C12','MX-04','completed',700,701,'kg','normal','{"planNo":"MES-PLAN-0729-04","batchNo":"BATCH-C12-014","components":[{"materialCode":"MAT-A101","quantity":480},{"materialCode":"MAT-D420","quantity":210},{"materialCode":"MAT-C310","quantity":12}]}','2026-07-29T08:12:00Z'),
('mes','forming','wip','WIP-0729-01','2026-07-29','PRODUCT-X1','通用制品 X1','BUFFER-F01','waiting',188,188,'piece','high','{"semiMaterialCode":"SEMI-A10","ageHours":3.5,"allocatedPlanNo":"CURE-PLAN-0729-01"}','2026-07-29T09:15:00Z'),
('mes','forming','wip','WIP-0729-02','2026-07-29','PRODUCT-X2','通用制品 X2','BUFFER-F01','waiting',54,54,'piece','normal','{"semiMaterialCode":"SEMI-B20","ageHours":6,"allocatedPlanNo":null}','2026-07-29T09:15:30Z'),
('mes','warehouse','shipment','SHIP-0729-01','2026-07-29','PRODUCT-X2','通用制品 X2','DOCK-02','completed',320,320,'piece','normal','{"direction":"outbound","vehicleSlot":"SLOT-03","packages":16,"demandNo":"DMD-0728-01"}','2026-07-29T08:47:30Z'),
('mes','warehouse','shipment','SHIP-0730-01','2026-07-30','PRODUCT-X1','通用制品 X1','DOCK-01','scheduled',260,0,'piece','high','{"direction":"outbound","vehicleSlot":"SLOT-01","packages":13,"demandNo":"DMD-0729-01"}','2026-07-30T07:30:00Z'),
('mes','equipment','inspection','EQI-0729-001','2026-07-29','MX-04','四号密炼单元','MX-04','completed',1,1,'case','normal','{"checkItems":[{"name":"冷却水温度","result":"warning"},{"name":"液压压力","result":"pass"}],"nextDue":"2026-07-30T08:00:00Z"}','2026-07-29T09:05:00Z'),
('mes','equipment','maintenance','EQM-0729-001','2026-07-29','CU-01','一号硫化单元','CU-01','running',1,0,'case','normal','{"maintenanceType":"planned","workOrder":"WO-0729-01","expectedEnd":"2026-07-29T12:00:00Z"}','2026-07-29T08:50:00Z'),
('mes','equipment','maintenance','EQM-0728-001','2026-07-28','MX-03','三号密炼单元','MX-03','completed',1,1,'case','normal','{"maintenanceType":"planned","result":"pass","nextDueDate":"2026-08-05"}','2026-07-28T15:00:00Z'),
('mes','mould','change_plan','MCHG-0730-001','2026-07-30','MOULD-X1-A','X1 通用模具 A','CU-03','scheduled',1,0,'case','high','{"equipmentCode":"CU-03","fromMould":"MOULD-X2-B","toMould":"MOULD-X1-A","plannedStart":"2026-07-30T08:00:00Z","reason":"schedule"}','2026-07-29T16:00:00Z'),
('mes','aps','master_plan','APS-MP-0730-01','2026-07-30','PRODUCT-X1','通用制品 X1','MOULD-X1-A','final',600,600,'piece','high','{"planId":"PLAN-0730-01","revision":2,"horizonDays":14,"startDate":"2026-07-30","endDate":"2026-08-01","demandNo":"DMD-0730-01","resourceType":"mould"}','2026-07-29T09:05:00Z'),
('mes','aps','master_plan','APS-MP-0730-02','2026-07-30','PRODUCT-X2','通用制品 X2','MOULD-X2-B','final',400,400,'piece','normal','{"planId":"PLAN-0730-01","revision":1,"horizonDays":14,"startDate":"2026-08-01","endDate":"2026-08-03","demandNo":"DMD-0730-02","resourceType":"mould"}','2026-07-29T09:05:30Z'),
('mes','aps','capacity','APS-CAP-0730-01','2026-07-30','LINE-GROUP-A','通用产线组 A','LINE-GROUP-A','tight',51,44,'hour','high','{"availableHours":44,"plannedHours":51,"bottleneck":true,"bottleneckProcess":"curing"}','2026-07-29T09:06:00Z'),
('mes','aps','capacity','APS-CAP-0730-02','2026-07-30','LINE-GROUP-B','通用产线组 B','LINE-GROUP-B','slack',30,40,'hour','normal','{"availableHours":40,"plannedHours":30,"bottleneck":false}','2026-07-29T09:06:30Z'),
('mes','personnel','shift_output','PO-0729-01','2026-07-29','TEAM-A','甲班','WS-MIX','completed',14,13,'person','normal','{"shiftCode":"day","processCode":"mixing","outputQuantity":2100,"outputUnit":"kg","relatedPlans":["MES-PLAN-0729-03"]}','2026-07-29T16:05:00Z'),
('mes','personnel','shift_output','PO-0729-02','2026-07-29','TEAM-B','乙班','WS-FORM','completed',12,12,'person','normal','{"shiftCode":"day","processCode":"forming","outputQuantity":242,"outputUnit":"piece","relatedPlans":["FORM-PLAN-0729-01"]}','2026-07-29T16:05:30Z'),
('mes','personnel','shift_output','PO-0729-03','2026-07-29','TEAM-C','丙班','WS-CURE','completed',10,9,'person','normal','{"shiftCode":"day","processCode":"curing","outputQuantity":171,"outputUnit":"piece","relatedPlans":["CURE-PROD-0729-01"]}','2026-07-29T16:06:00Z');

-- 设备主数据补齐：process_record / 计划引用的机台全部有档。
INSERT OR IGNORE INTO industrial_demo_equipment_state VALUES
('mes','FM-02','二号成型单元','forming','WS-FORM','running',77.3,'FORM-PLAN-0729-01',NULL,'2026-07-29T09:11:00Z'),
('mes','CU-02','二号硫化单元','curing','WS-CURE','idle',71.0,NULL,NULL,'2026-07-29T09:04:00Z'),
('mes','CU-03','三号硫化单元','curing','WS-CURE','running',80.2,'CURE-PROD-0729-01',NULL,'2026-07-29T09:11:30Z'),
('mes','FQC-LINE-01','成品检验一线','quality','WS-QC','running',65.0,NULL,NULL,'2026-07-29T09:00:00Z');

-- 跨工序设备事件：成型 / 硫化 / 质检段也有事件，配合 _11equipment/events。
INSERT OR IGNORE INTO industrial_demo_equipment_event VALUES
('mes','EVT-0729-101','FM-01','unplanned_stop','medium','feeding_jam','2026-07-29T05:40:00Z','2026-07-29T06:05:00Z','resolved'),
('mes','EVT-0729-102','CU-02','process_warning','low','temperature','2026-07-29T07:50:00Z','2026-07-29T08:05:00Z','resolved'),
('mes','EVT-0729-103','FQC-LINE-01','speed_loss','low','manual','2026-07-29T08:30:00Z','2026-07-29T08:45:00Z','resolved');

-- 工艺标准与 BOM（reference_object 新 object_type）。
INSERT OR IGNORE INTO industrial_demo_reference_object VALUES
('mes','process_standard','STD-MIX-01','密炼通用工艺标准','mixing','4.1','active',NULL,'{"parameters":[{"code":"mix_temp_max","value":165,"unit":"C"},{"code":"mix_time_s","value":210,"unit":"s"},{"code":"dump_temp_max","value":170,"unit":"C"}],"approved":true}','2026-07-20T10:00:00Z'),
('mes','process_standard','STD-CUR-01','硫化通用工艺标准','curing','2.0','active',NULL,'{"parameters":[{"code":"cure_temp","value":178,"unit":"C"},{"code":"cycle_s","value":720,"unit":"s"},{"code":"pressure_mpa","value":2.4,"unit":"MPa"}],"approved":true}','2026-07-21T10:00:00Z'),
('mes','bom','BOM-X1','通用制品 X1 结构','forming','1.3','active',NULL,'{"components":[{"itemCode":"SEMI-A10","quantity":2.4,"unit":"m"},{"itemCode":"SEMI-B20","quantity":1.1,"unit":"m"},{"itemCode":"MAT-D420","quantity":0.3,"unit":"kg"}]}','2026-07-18T10:00:00Z'),
('mes','bom','BOM-X2','通用制品 X2 结构','forming','1.1','active',NULL,'{"components":[{"itemCode":"SEMI-B20","quantity":3,"unit":"m"}]}','2026-07-18T10:05:00Z'),
('mes','team','TEAM-A','甲班','mixing','1','active',NULL,'{"headcount":14,"skillTags":["mixing","forklift"]}','2026-07-01T09:00:00Z'),
('mes','team','TEAM-B','乙班','forming','1','active',NULL,'{"headcount":12,"skillTags":["forming"]}','2026-07-01T09:00:00Z'),
('mes','team','TEAM-C','丙班','curing','1','active',NULL,'{"headcount":10,"skillTags":["curing","mould_change"]}','2026-07-01T09:00:00Z'),
('mes','team','TEAM-D','丁班','mixing','1','active',NULL,'{"headcount":13,"skillTags":["mixing"]}','2026-07-01T09:00:00Z'),
('mes','calendar','CAL-2026','工厂日历 2026','general','2026','active',NULL,'{"workdays":"Mon-Sat","holidays":["2026-10-01","2026-10-02","2026-10-03"],"plannedMaintenanceDays":["2026-08-16"]}','2026-07-01T08:00:00Z'),
('mes','shift_template','SHIFT-DAY','早班模板','general','1','active',NULL,'{"startTime":"08:00","endTime":"16:00","breaks":[{"start":"12:00","durationMin":30}]}','2026-07-01T08:00:00Z'),
('mes','shift_template','SHIFT-NIGHT','夜班模板','general','1','active',NULL,'{"startTime":"20:00","endTime":"04:00+1","breaks":[{"start":"00:00","durationMin":30}]}','2026-07-01T08:00:00Z'),
('mes','scheduling_rule','RULE-RESOURCE-COMPAT','资源兼容','general','1','active',NULL,'{"ruleType":"hard","scope":"ap+as","explanation":"工单只能排在与其物料、模具兼容的资源上"}','2026-07-01T08:00:00Z'),
('mes','scheduling_rule','RULE-DELIVERY','交期守时','general','1','active',NULL,'{"ruleType":"soft","scope":"ap+as","explanation":"延期按分钟罚分，排产优先满足交付日期"}','2026-07-01T08:00:00Z'),
('mes','scheduling_rule','RULE-ASAP','尽早生产','general','1','active',NULL,'{"ruleType":"soft","scope":"ap","explanation":"在交期允许内尽量提前完成，留出缓冲"}','2026-07-01T08:00:00Z'),
('mes','scheduling_rule','RULE-GROUPING','同需求聚集','general','1','active',NULL,'{"ruleType":"soft","scope":"ap","explanation":"同一需求的子任务尽量排在一起，便于跟踪与齐套"}','2026-07-01T08:00:00Z'),
('mes','scheduling_rule','RULE-CHANGEOVER','换型最少','general','1','active',NULL,'{"ruleType":"soft","scope":"as","explanation":"相邻工单尽量同物料同模具，减少换型；换模从下一个早班开始"}','2026-07-01T08:00:00Z'),
('mes','scheduling_rule','RULE-CALENDAR','日历对齐','general','1','active',NULL,'{"ruleType":"hard","scope":"ap+as","explanation":"开始时间不得早于就绪时间，且必须落在资源日历可用段内"}','2026-07-01T08:00:00Z'),
('mes','scheduling_rule','RULE-GROUP-SYNC','成组资源同步','general','1','active',NULL,'{"ruleType":"hard","scope":"as","explanation":"成组使用的关联资源上的工单必须同时开始"}','2026-07-01T08:00:00Z');

CREATE TABLE IF NOT EXISTS iris_conversation (
    conversation_id TEXT PRIMARY KEY,
    root_branch_id TEXT NOT NULL,
    title TEXT,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    -- 归档只是从列表收起，历史照常完整保留（不变量 1）；恢复时清空回 NULL。
    archived_at TEXT
);

CREATE TABLE IF NOT EXISTS conversation_branch (
    branch_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    parent_branch_id TEXT,
    status TEXT NOT NULL,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES iris_conversation(conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_branch_conversation
    ON conversation_branch(conversation_id);

CREATE TABLE IF NOT EXISTS branch_fork (
    branch_id TEXT PRIMARY KEY,
    source_branch_id TEXT NOT NULL,
    anchor_message_id TEXT NOT NULL,
    source_turn_id TEXT NOT NULL,
    source_event_sequence INTEGER NOT NULL,
    base_context_frame_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (branch_id) REFERENCES conversation_branch(branch_id),
    FOREIGN KEY (source_branch_id) REFERENCES conversation_branch(branch_id),
    FOREIGN KEY (anchor_message_id) REFERENCES message(message_id),
    FOREIGN KEY (source_turn_id) REFERENCES conversation_turn(turn_id),
    FOREIGN KEY (base_context_frame_id) REFERENCES context_frame(frame_id)
);

CREATE TABLE IF NOT EXISTS message (
    message_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    client_request_id TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES iris_conversation(conversation_id),
    FOREIGN KEY (branch_id) REFERENCES conversation_branch(branch_id)
);

CREATE INDEX IF NOT EXISTS idx_message_branch_created
    ON message(conversation_id, branch_id, created_at);

CREATE TABLE IF NOT EXISTS message_attachment (
    message_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    artifact_ref TEXT NOT NULL,
    PRIMARY KEY (message_id, ordinal),
    FOREIGN KEY (message_id) REFERENCES message(message_id)
);

CREATE TABLE IF NOT EXISTS conversation_turn (
    turn_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    request_message_id TEXT NOT NULL,
    root_run_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    version INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    FOREIGN KEY (conversation_id) REFERENCES iris_conversation(conversation_id),
    FOREIGN KEY (branch_id) REFERENCES conversation_branch(branch_id),
    FOREIGN KEY (request_message_id) REFERENCES message(message_id)
);

CREATE INDEX IF NOT EXISTS idx_turn_branch_started
    ON conversation_turn(conversation_id, branch_id, started_at);

CREATE TABLE IF NOT EXISTS context_frame (
    frame_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    owner_branch_id TEXT,
    parent_frame_id TEXT,
    frame_kind TEXT NOT NULL,
    waterline_sequence INTEGER NOT NULL,
    before_turn_id TEXT,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES iris_conversation(conversation_id),
    FOREIGN KEY (owner_branch_id) REFERENCES conversation_branch(branch_id),
    FOREIGN KEY (parent_frame_id) REFERENCES context_frame(frame_id),
    FOREIGN KEY (before_turn_id) REFERENCES conversation_turn(turn_id)
);

CREATE INDEX IF NOT EXISTS idx_context_frame_parent
    ON context_frame(conversation_id, parent_frame_id);

CREATE TABLE IF NOT EXISTS branch_context_head (
    branch_id TEXT PRIMARY KEY,
    frame_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (branch_id) REFERENCES conversation_branch(branch_id),
    FOREIGN KEY (frame_id) REFERENCES context_frame(frame_id)
);

CREATE TABLE IF NOT EXISTS turn_supplement (
    supplement_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    message_id TEXT,
    text_content TEXT NOT NULL,
    attachment_refs_json TEXT NOT NULL,
    phase TEXT NOT NULL,
    injected_after_round_id TEXT,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES iris_conversation(conversation_id),
    FOREIGN KEY (branch_id) REFERENCES conversation_branch(branch_id),
    FOREIGN KEY (turn_id) REFERENCES conversation_turn(turn_id),
    FOREIGN KEY (message_id) REFERENCES message(message_id)
);

CREATE INDEX IF NOT EXISTS idx_supplement_turn_phase
    ON turn_supplement(turn_id, phase, created_at);

CREATE TABLE IF NOT EXISTS turn_stop_request (
    stop_request_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    turn_id TEXT NOT NULL UNIQUE,
    root_run_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    phase TEXT NOT NULL,
    version INTEGER NOT NULL,
    requested_at TEXT NOT NULL,
    completed_at TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES iris_conversation(conversation_id),
    FOREIGN KEY (branch_id) REFERENCES conversation_branch(branch_id),
    FOREIGN KEY (turn_id) REFERENCES conversation_turn(turn_id)
);

CREATE TABLE IF NOT EXISTS agent_run (
    run_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    parent_run_id TEXT,
    root_run_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    purpose TEXT NOT NULL,
    phase TEXT NOT NULL,
    version INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    FOREIGN KEY (conversation_id) REFERENCES iris_conversation(conversation_id),
    FOREIGN KEY (branch_id) REFERENCES conversation_branch(branch_id),
    FOREIGN KEY (turn_id) REFERENCES conversation_turn(turn_id)
);

CREATE INDEX IF NOT EXISTS idx_run_turn
    ON agent_run(conversation_id, turn_id);

-- User/approval waits are durable boundaries, not active Agent compute time.
-- Keeping intervals separately avoids rewriting the canonical Run row and lets
-- a resumed Run retain its original identity, history, and cumulative budget.
CREATE TABLE IF NOT EXISTS agent_run_suspension (
    suspension_id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    FOREIGN KEY (run_id) REFERENCES agent_run(run_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_run_open_suspension
    ON agent_run_suspension(run_id)
    WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agent_run_suspension_history
    ON agent_run_suspension(run_id, started_at);

CREATE TABLE IF NOT EXISTS agent_task_definition (
    task_id TEXT NOT NULL,
    definition_version INTEGER NOT NULL,
    conversation_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    objective TEXT NOT NULL,
    constraints_json TEXT NOT NULL,
    completion_criteria_json TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    source_run_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (task_id, definition_version),
    FOREIGN KEY (conversation_id) REFERENCES iris_conversation(conversation_id),
    FOREIGN KEY (branch_id) REFERENCES conversation_branch(branch_id),
    FOREIGN KEY (source_message_id) REFERENCES message(message_id),
    FOREIGN KEY (source_run_id) REFERENCES agent_run(run_id)
);

CREATE TABLE IF NOT EXISTS agent_task_work_state (
    task_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    state_version INTEGER NOT NULL,
    phase TEXT NOT NULL,
    steps_json TEXT NOT NULL,
    blockers_json TEXT NOT NULL,
    evidence_refs_json TEXT NOT NULL,
    artifact_refs_json TEXT NOT NULL,
    summary TEXT NOT NULL,
    source_run_id TEXT NOT NULL,
    source_round_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (task_id, branch_id, state_version),
    FOREIGN KEY (branch_id) REFERENCES conversation_branch(branch_id),
    FOREIGN KEY (source_run_id) REFERENCES agent_run(run_id),
    FOREIGN KEY (source_round_id) REFERENCES agent_round(round_id)
);

CREATE TABLE IF NOT EXISTS agent_task_head (
    task_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    definition_version INTEGER NOT NULL,
    state_version INTEGER NOT NULL,
    phase TEXT NOT NULL,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (task_id, branch_id),
    FOREIGN KEY (task_id, definition_version)
        REFERENCES agent_task_definition(task_id, definition_version),
    FOREIGN KEY (task_id, branch_id, state_version)
        REFERENCES agent_task_work_state(task_id, branch_id, state_version),
    FOREIGN KEY (conversation_id) REFERENCES iris_conversation(conversation_id),
    FOREIGN KEY (branch_id) REFERENCES conversation_branch(branch_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_task_head_branch
    ON agent_task_head(conversation_id, branch_id, updated_at);

-- Optional control-plane fields evolve independently from the immutable work
-- state row. Existing databases therefore gain the richer task view without
-- rewriting or fabricating historical state revisions.
CREATE TABLE IF NOT EXISTS agent_task_state_control (
    task_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    state_version INTEGER NOT NULL,
    current_focus TEXT NOT NULL,
    pending_decisions_json TEXT NOT NULL,
    next_actions_json TEXT NOT NULL,
    handoff_note TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (task_id, branch_id, state_version),
    FOREIGN KEY (task_id, branch_id, state_version)
        REFERENCES agent_task_work_state(task_id, branch_id, state_version)
);

-- A checkpoint is an index into an immutable state revision, not a copy of
-- task content and not a promise that external side effects can be rolled back.
CREATE TABLE IF NOT EXISTS agent_task_checkpoint (
    checkpoint_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    state_version INTEGER NOT NULL,
    checkpoint_kind TEXT NOT NULL,
    resume_summary TEXT NOT NULL,
    source_run_id TEXT NOT NULL,
    source_round_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (task_id, branch_id, state_version, checkpoint_kind),
    FOREIGN KEY (task_id, branch_id, state_version)
        REFERENCES agent_task_work_state(task_id, branch_id, state_version),
    FOREIGN KEY (source_run_id) REFERENCES agent_run(run_id),
    FOREIGN KEY (source_round_id) REFERENCES agent_round(round_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_task_checkpoint_latest
    ON agent_task_checkpoint(task_id, branch_id, created_at);

-- Run/Task membership is explicit so recovery and handoff do not infer task
-- ownership from whichever Run happened to write the latest state revision.
CREATE TABLE IF NOT EXISTS agent_run_task_link (
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    linked_state_version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (run_id, task_id, relation),
    FOREIGN KEY (run_id) REFERENCES agent_run(run_id),
    FOREIGN KEY (task_id, branch_id)
        REFERENCES agent_task_head(task_id, branch_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_run_task_by_task
    ON agent_run_task_link(task_id, branch_id, updated_at);

CREATE TABLE IF NOT EXISTS artifact (
    artifact_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    name TEXT NOT NULL,
    title TEXT NOT NULL,
    kind TEXT NOT NULL,
    latest_version INTEGER NOT NULL,
    source_run_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES iris_conversation(conversation_id),
    FOREIGN KEY (branch_id) REFERENCES conversation_branch(branch_id),
    FOREIGN KEY (source_run_id) REFERENCES agent_run(run_id)
);

CREATE TABLE IF NOT EXISTS artifact_version (
    artifact_id TEXT NOT NULL,
    artifact_version INTEGER NOT NULL,
    object_ref TEXT NOT NULL,
    media_type TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    byte_count INTEGER NOT NULL,
    workspace_path TEXT,
    workspace_version TEXT,
    origin_execution_id TEXT,
    registration_execution_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (artifact_id, artifact_version),
    FOREIGN KEY (artifact_id) REFERENCES artifact(artifact_id),
    FOREIGN KEY (origin_execution_id) REFERENCES tool_execution(execution_id),
    FOREIGN KEY (registration_execution_id)
        REFERENCES tool_execution(execution_id)
);

CREATE TABLE IF NOT EXISTS artifact_visibility (
    artifact_id TEXT NOT NULL,
    artifact_version INTEGER NOT NULL,
    visibility TEXT NOT NULL,
    source_execution_id TEXT NOT NULL,
    source_run_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (artifact_id, artifact_version, visibility),
    FOREIGN KEY (artifact_id, artifact_version)
        REFERENCES artifact_version(artifact_id, artifact_version),
    FOREIGN KEY (source_execution_id) REFERENCES tool_execution(execution_id),
    FOREIGN KEY (source_run_id) REFERENCES agent_run(run_id)
);

CREATE TABLE IF NOT EXISTS artifact_publication (
    publication_execution_id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    artifact_version INTEGER NOT NULL,
    visibility TEXT NOT NULL,
    source_run_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (artifact_id, artifact_version)
        REFERENCES artifact_version(artifact_id, artifact_version),
    FOREIGN KEY (publication_execution_id)
        REFERENCES tool_execution(execution_id),
    FOREIGN KEY (source_run_id) REFERENCES agent_run(run_id)
);

CREATE INDEX IF NOT EXISTS idx_artifact_conversation
    ON artifact(conversation_id, branch_id, created_at);

-- User ingress is a provenance subtype, not a fabricated ToolExecution.
-- It shares the artifact:// reference grammar and immutable object store.
CREATE TABLE IF NOT EXISTS user_artifact (
    artifact_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    name TEXT NOT NULL,
    title TEXT NOT NULL,
    kind TEXT NOT NULL,
    latest_version INTEGER NOT NULL,
    upload_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES iris_conversation(conversation_id),
    FOREIGN KEY (branch_id) REFERENCES conversation_branch(branch_id)
);

CREATE TABLE IF NOT EXISTS user_artifact_version (
    artifact_id TEXT NOT NULL,
    artifact_version INTEGER NOT NULL,
    object_ref TEXT NOT NULL,
    media_type TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    byte_count INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (artifact_id, artifact_version),
    FOREIGN KEY (artifact_id) REFERENCES user_artifact(artifact_id)
);

CREATE INDEX IF NOT EXISTS idx_user_artifact_conversation
    ON user_artifact(conversation_id, branch_id, created_at);

CREATE TABLE IF NOT EXISTS artifact_render_link (
    artifact_id TEXT NOT NULL,
    artifact_version INTEGER NOT NULL,
    visibility TEXT NOT NULL,
    publication_execution_id TEXT NOT NULL UNIQUE,
    node_id TEXT NOT NULL UNIQUE,
    PRIMARY KEY (artifact_id, artifact_version, visibility),
    FOREIGN KEY (artifact_id, artifact_version)
        REFERENCES artifact_version(artifact_id, artifact_version),
    FOREIGN KEY (publication_execution_id)
        REFERENCES tool_execution(execution_id),
    FOREIGN KEY (node_id) REFERENCES render_node_projection(node_id)
);

CREATE TABLE IF NOT EXISTS run_failure (
    failure_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL UNIQUE,
    code TEXT NOT NULL,
    category TEXT NOT NULL,
    user_message TEXT NOT NULL,
    trace_id TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,
    recovery_action TEXT NOT NULL,
    side_effect_outcome TEXT NOT NULL,
    details_ref TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES agent_run(run_id)
);

CREATE TABLE IF NOT EXISTS run_closure_ledger (
    run_id TEXT PRIMARY KEY,
    execution_status TEXT NOT NULL,
    task_outcome TEXT NOT NULL,
    terminal_reason TEXT NOT NULL,
    final_stop_reason TEXT,
    round_count INTEGER NOT NULL,
    model_attempt_count INTEGER NOT NULL,
    tool_call_count INTEGER NOT NULL,
    tool_execution_count INTEGER NOT NULL,
    tool_observation_count INTEGER NOT NULL,
    tool_succeeded_count INTEGER NOT NULL,
    tool_failed_count INTEGER NOT NULL,
    tool_outcome_unknown_count INTEGER NOT NULL,
    tool_rejected_count INTEGER NOT NULL,
    tool_expired_count INTEGER NOT NULL,
    unmatched_tool_call_count INTEGER NOT NULL,
    orphan_tool_execution_count INTEGER NOT NULL,
    non_terminal_execution_count INTEGER NOT NULL,
    missing_observation_count INTEGER NOT NULL,
    evidence_count INTEGER NOT NULL,
    artifact_count INTEGER NOT NULL,
    has_final_answer INTEGER NOT NULL,
    recorded_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES agent_run(run_id)
);

CREATE TABLE IF NOT EXISTS run_definition_snapshot (
    run_id TEXT PRIMARY KEY,
    definition_id TEXT NOT NULL,
    definition_version TEXT NOT NULL,
    snapshot_hash TEXT NOT NULL,
    normalized_input_hash TEXT NOT NULL,
    dependency_snapshot_ref TEXT,
    tool_calls_limit INTEGER NOT NULL,
    time_limit_ms INTEGER NOT NULL,
    FOREIGN KEY (run_id) REFERENCES agent_run(run_id)
);

-- A Run's durable invocation edge is kept separately from agent_run so the
-- parent/child graph can evolve without turning the lifecycle row into a
-- polymorphic payload. The edge is also the correlation fact used by SSE.
CREATE TABLE IF NOT EXISTS run_invocation (
    run_id TEXT PRIMARY KEY,
    parent_run_id TEXT,
    invoking_step_run_id TEXT,
    trigger_kind TEXT NOT NULL,
    trigger_ref TEXT,
    requested_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES agent_run(run_id),
    FOREIGN KEY (parent_run_id) REFERENCES agent_run(run_id)
);

CREATE INDEX IF NOT EXISTS idx_run_invocation_parent
    ON run_invocation(parent_run_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_run_invocation_idempotency
    ON run_invocation(parent_run_id, trigger_kind, trigger_ref)
    WHERE trigger_ref IS NOT NULL;

-- Run-local context is an explicit input object. Isolated child Agents never
-- infer their task by replaying their parent's complete conversation.
CREATE TABLE IF NOT EXISTS agent_run_context (
    run_id TEXT PRIMARY KEY,
    context_mode TEXT NOT NULL,
    task_text TEXT NOT NULL,
    result_contract TEXT NOT NULL,
    allowed_tool_names_json TEXT NOT NULL,
    nesting_depth INTEGER NOT NULL,
    source_context_ref TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES agent_run(run_id)
);

CREATE TABLE IF NOT EXISTS agent_run_result (
    run_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    summary_text TEXT NOT NULL,
    output_ref TEXT,
    evidence_refs_json TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES agent_run(run_id)
);

-- Mailbox messages cross asynchronous Run boundaries. Process callbacks only
-- wake a Run; queued/injected state remains the canonical delivery fact.
CREATE TABLE IF NOT EXISTS run_mailbox_message (
    message_id TEXT PRIMARY KEY,
    target_run_id TEXT NOT NULL,
    source_run_id TEXT,
    message_kind TEXT NOT NULL,
    content TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    phase TEXT NOT NULL,
    injection_round_id TEXT,
    created_at TEXT NOT NULL,
    injected_at TEXT,
    FOREIGN KEY (target_run_id) REFERENCES agent_run(run_id),
    FOREIGN KEY (source_run_id) REFERENCES agent_run(run_id),
    FOREIGN KEY (injection_round_id) REFERENCES agent_round(round_id)
);

CREATE INDEX IF NOT EXISTS idx_run_mailbox_delivery
    ON run_mailbox_message(target_run_id, phase, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_run_terminal_notification
    ON run_mailbox_message(target_run_id, source_run_id, message_kind)
    WHERE source_run_id IS NOT NULL
      AND message_kind IN ('completion', 'cancellation');

-- Pipeline definitions are code-defined in M0; each accepted Run freezes the
-- serialized definition/input in run_definition_snapshot + this input row.
CREATE TABLE IF NOT EXISTS pipeline_run_input (
    run_id TEXT PRIMARY KEY,
    input_json TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    trigger_kind TEXT NOT NULL,
    trigger_ref TEXT,
    delivery_policy TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES agent_run(run_id)
);

CREATE TABLE IF NOT EXISTS pipeline_step_run (
    step_run_id TEXT PRIMARY KEY,
    pipeline_run_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    step_index INTEGER NOT NULL,
    step_kind TEXT NOT NULL,
    phase TEXT NOT NULL,
    child_run_id TEXT,
    tool_execution_id TEXT,
    input_json TEXT NOT NULL,
    output_json TEXT,
    failure_code TEXT,
    version INTEGER NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (pipeline_run_id, step_id),
    UNIQUE (pipeline_run_id, step_index),
    FOREIGN KEY (pipeline_run_id) REFERENCES agent_run(run_id),
    FOREIGN KEY (child_run_id) REFERENCES agent_run(run_id),
    FOREIGN KEY (tool_execution_id) REFERENCES tool_execution(execution_id)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_step_child
    ON pipeline_step_run(child_run_id, phase);

CREATE INDEX IF NOT EXISTS idx_pipeline_step_tool
    ON pipeline_step_run(tool_execution_id, phase);

-- Reusable semantic vectors. The cache identity includes the model and text
-- normalization version so an encoder upgrade cannot silently reuse stale data.
CREATE TABLE IF NOT EXISTS semantic_embedding_cache (
    model_identity TEXT NOT NULL,
    normalization_version TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    dimension INTEGER NOT NULL,
    vector_blob BLOB NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL,
    PRIMARY KEY (model_identity, normalization_version, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_semantic_embedding_last_used
    ON semantic_embedding_cache(last_used_at);

CREATE TABLE IF NOT EXISTS agent_round (
    round_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    round_index INTEGER NOT NULL,
    phase TEXT NOT NULL,
    answer_node_id TEXT,
    tool_call_count INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (run_id, round_index),
    FOREIGN KEY (conversation_id) REFERENCES iris_conversation(conversation_id),
    FOREIGN KEY (turn_id) REFERENCES conversation_turn(turn_id),
    FOREIGN KEY (run_id) REFERENCES agent_run(run_id)
);

CREATE TABLE IF NOT EXISTS render_node_projection (
    node_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    branch_id TEXT,
    turn_id TEXT,
    run_id TEXT,
    round_id TEXT,
    pipeline_step_run_id TEXT,
    node_type TEXT NOT NULL,
    node_status TEXT NOT NULL,
    group_id TEXT,
    ordinal INTEGER NOT NULL,
    renderer_key TEXT NOT NULL,
    version INTEGER NOT NULL,
    final_content_hash TEXT,
    projection_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES iris_conversation(conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_render_node_turn
    ON render_node_projection(conversation_id, turn_id, ordinal);

CREATE TABLE IF NOT EXISTS compact_boundary (
    boundary_id TEXT PRIMARY KEY,
    frame_id TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    before_turn_id TEXT NOT NULL,
    trigger TEXT NOT NULL,
    covered_count INTEGER NOT NULL,
    summary_artifact_ref TEXT NOT NULL,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES iris_conversation(conversation_id),
    FOREIGN KEY (frame_id) REFERENCES context_frame(frame_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_compact_boundary_position
    ON compact_boundary(conversation_id, branch_id, before_turn_id);

CREATE TABLE IF NOT EXISTS compact_summary (
    summary_artifact_ref TEXT PRIMARY KEY,
    boundary_id TEXT NOT NULL UNIQUE,
    summary_text TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    estimated_tokens INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (boundary_id) REFERENCES compact_boundary(boundary_id)
);

CREATE TABLE IF NOT EXISTS compaction_run (
    run_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    parent_frame_id TEXT NOT NULL,
    source_start_sequence INTEGER NOT NULL,
    waterline_sequence INTEGER NOT NULL,
    before_turn_id TEXT NOT NULL,
    source_snapshot_id TEXT,
    compact_boundary_id TEXT,
    failure_json TEXT,
    version INTEGER NOT NULL,
    requested_at TEXT NOT NULL,
    ended_at TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES agent_run(run_id),
    FOREIGN KEY (conversation_id) REFERENCES iris_conversation(conversation_id),
    FOREIGN KEY (branch_id) REFERENCES conversation_branch(branch_id),
    FOREIGN KEY (parent_frame_id) REFERENCES context_frame(frame_id),
    FOREIGN KEY (before_turn_id) REFERENCES conversation_turn(turn_id),
    FOREIGN KEY (compact_boundary_id) REFERENCES compact_boundary(boundary_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_compaction_branch_active
    ON compaction_run(conversation_id, branch_id)
    WHERE phase IN ('accepted', 'running');

CREATE TABLE IF NOT EXISTS compaction_source_snapshot (
    snapshot_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL UNIQUE,
    content_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    fact_count INTEGER NOT NULL,
    estimated_tokens INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES compaction_run(run_id)
);

CREATE TABLE IF NOT EXISTS attention_projection (
    attention_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    branch_id TEXT,
    turn_id TEXT,
    run_id TEXT,
    status TEXT NOT NULL,
    projection_json TEXT NOT NULL,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES iris_conversation(conversation_id)
);

CREATE TABLE IF NOT EXISTS tool_render_link (
    tool_call_id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL UNIQUE,
    FOREIGN KEY (node_id) REFERENCES render_node_projection(node_id)
);

CREATE TABLE IF NOT EXISTS approval_attention_link (
    approval_id TEXT PRIMARY KEY,
    attention_id TEXT NOT NULL UNIQUE,
    node_id TEXT NOT NULL UNIQUE,
    FOREIGN KEY (node_id) REFERENCES render_node_projection(node_id)
);

CREATE TABLE IF NOT EXISTS conversation_event (
    conversation_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    event_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    branch_id TEXT,
    turn_id TEXT,
    run_id TEXT,
    parent_run_id TEXT,
    aggregate_kind TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    aggregate_version INTEGER NOT NULL,
    causation_id TEXT,
    correlation_id TEXT,
    occurred_at TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (conversation_id, sequence),
    FOREIGN KEY (conversation_id) REFERENCES iris_conversation(conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_event_cursor
    ON conversation_event(conversation_id, event_id);

CREATE TABLE IF NOT EXISTS idempotency_record (
    subject_id TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    http_status INTEGER NOT NULL,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (subject_id, endpoint, idempotency_key)
);

CREATE TABLE IF NOT EXISTS tool_execution (
    execution_id TEXT PRIMARY KEY,
    tool_call_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    round_id TEXT,
    tool_id TEXT NOT NULL,
    tool_version TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    capability_path TEXT NOT NULL,
    manifest_hash TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    phase TEXT NOT NULL,
    snapshot_id TEXT,
    approval_id TEXT,
    outcome_kind TEXT,
    output_json TEXT,
    error_code TEXT,
    error_message TEXT,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (conversation_id, tool_call_id),
    FOREIGN KEY (conversation_id) REFERENCES iris_conversation(conversation_id),
    FOREIGN KEY (turn_id) REFERENCES conversation_turn(turn_id),
    FOREIGN KEY (run_id) REFERENCES agent_run(run_id)
);

CREATE INDEX IF NOT EXISTS idx_tool_execution_run
    ON tool_execution(conversation_id, run_id, created_at);

CREATE TABLE IF NOT EXISTS capability_definition (
    capability_id TEXT NOT NULL,
    definition_version TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    capability_path TEXT NOT NULL,
    description TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    definition_status TEXT NOT NULL,
    manifest_hash TEXT NOT NULL,
    snapshot_object_ref TEXT NOT NULL,
    snapshot_content_hash TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY (capability_id, definition_version)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_capability_definition_path_version
    ON capability_definition(capability_path, definition_version);

CREATE TABLE IF NOT EXISTS capability_binding_state (
    capability_id TEXT NOT NULL,
    definition_version TEXT NOT NULL,
    provider_key TEXT NOT NULL,
    availability TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    last_seen_at TEXT,
    PRIMARY KEY (
        capability_id,
        definition_version,
        provider_key
    ),
    FOREIGN KEY (capability_id, definition_version)
        REFERENCES capability_definition(
            capability_id,
            definition_version
        )
);

CREATE TABLE IF NOT EXISTS tool_output_payload (
    execution_id TEXT PRIMARY KEY,
    object_ref TEXT NOT NULL,
    media_type TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    byte_count INTEGER NOT NULL,
    character_count INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (execution_id) REFERENCES tool_execution(execution_id)
);

CREATE TABLE IF NOT EXISTS workspace_checkpoint_set (
    checkpoint_id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL UNIQUE,
    phase TEXT NOT NULL,
    created_at TEXT NOT NULL,
    applied_at TEXT,
    FOREIGN KEY (execution_id) REFERENCES tool_execution(execution_id)
);

CREATE TABLE IF NOT EXISTS workspace_checkpoint_item (
    checkpoint_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    logical_path TEXT NOT NULL,
    resource_kind TEXT NOT NULL,
    change_kind TEXT NOT NULL,
    before_exists INTEGER NOT NULL,
    before_object_ref TEXT,
    before_hash TEXT NOT NULL,
    before_size INTEGER NOT NULL,
    before_modified_at TEXT,
    after_hash TEXT,
    PRIMARY KEY (checkpoint_id, ordinal),
    UNIQUE (checkpoint_id, logical_path),
    FOREIGN KEY (checkpoint_id)
        REFERENCES workspace_checkpoint_set(checkpoint_id)
);

CREATE TABLE IF NOT EXISTS operation_snapshot (
    snapshot_id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL UNIQUE,
    manifest_hash TEXT NOT NULL,
    normalized_input_json TEXT NOT NULL,
    impact_statement TEXT NOT NULL,
    resources_json TEXT NOT NULL,
    snapshot_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (execution_id) REFERENCES tool_execution(execution_id)
);

CREATE TABLE IF NOT EXISTS tool_approval_request (
    approval_id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL UNIQUE,
    snapshot_hash TEXT NOT NULL,
    status TEXT NOT NULL,
    impact_statement TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    decision_key TEXT UNIQUE,
    decision_by TEXT,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    decided_at TEXT,
    FOREIGN KEY (execution_id) REFERENCES tool_execution(execution_id)
);

CREATE INDEX IF NOT EXISTS idx_tool_approval_waiting
    ON tool_approval_request(status, expires_at);

CREATE TABLE IF NOT EXISTS tool_user_input_request (
    input_request_id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL UNIQUE,
    question TEXT NOT NULL,
    options_json TEXT NOT NULL,
    recommended_option_id TEXT,
    status TEXT NOT NULL,
    answer_option_id TEXT,
    answer_value TEXT,
    decision_key TEXT UNIQUE,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    resolved_at TEXT,
    FOREIGN KEY (execution_id) REFERENCES tool_execution(execution_id)
);

-- User-managed Skills are immutable definitions with one mutable head. A
-- disabled head disappears from the live Catalog while historical versions
-- remain addressable through capability_definition.
CREATE TABLE IF NOT EXISTS skill_definition (
    skill_id TEXT NOT NULL,
    definition_version INTEGER NOT NULL,
    name TEXT NOT NULL,
    title TEXT NOT NULL,
    capability_path TEXT NOT NULL,
    description TEXT NOT NULL,
    when_to_use TEXT NOT NULL,
    instructions_object_ref TEXT NOT NULL,
    instructions_content_hash TEXT NOT NULL,
    dependencies_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (skill_id, definition_version),
    UNIQUE (capability_path, definition_version)
);

CREATE TABLE IF NOT EXISTS skill_head (
    skill_id TEXT PRIMARY KEY,
    definition_version INTEGER NOT NULL,
    lifecycle_status TEXT NOT NULL,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (skill_id, definition_version)
        REFERENCES skill_definition(skill_id, definition_version)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_head_active_name
    ON skill_head(skill_id, lifecycle_status);

-- MCP server configuration is management-plane state. Credentials never
-- enter SQLite: authorization_env only names an environment variable. The
-- discovered tool snapshot is replaceable runtime state; immutable
-- capability_definition rows retain the definitions used by past runs.
CREATE TABLE IF NOT EXISTS mcp_server (
    server_id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    transport TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    authorization_env TEXT,
    enabled INTEGER NOT NULL,
    connection_state TEXT NOT NULL,
    protocol_version TEXT,
    remote_server_name TEXT,
    remote_server_version TEXT,
    instructions TEXT,
    tool_count INTEGER NOT NULL,
    last_error TEXT,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    checked_at TEXT
);

CREATE TABLE IF NOT EXISTS mcp_server_tool (
    server_id TEXT NOT NULL,
    remote_name TEXT NOT NULL,
    local_name TEXT NOT NULL,
    capability_id TEXT NOT NULL,
    definition_version TEXT NOT NULL,
    capability_path TEXT NOT NULL,
    description TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    manifest_hash TEXT NOT NULL,
    active INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (server_id, remote_name),
    UNIQUE (local_name),
    FOREIGN KEY (server_id) REFERENCES mcp_server(server_id)
);

CREATE INDEX IF NOT EXISTS idx_mcp_server_tool_active
    ON mcp_server_tool(server_id, active, local_name);

-- stdio 传输的连接参数（docs/31 §5.3）。env_names 只存变量名，
-- 值永远来自进程环境，不落库。endpoint 列对 stdio 行存 command 展示串。
CREATE TABLE IF NOT EXISTS mcp_server_stdio (
    server_id TEXT PRIMARY KEY,
    command_json TEXT NOT NULL,
    env_names_json TEXT NOT NULL,
    FOREIGN KEY (server_id) REFERENCES mcp_server(server_id)
);

-- 声明来源：经拓展根 *.mcp.yml 注册的连接器记录其根与文件，
-- 根被移除时对应连接器停用（历史定义保留，docs/31 §6）。
CREATE TABLE IF NOT EXISTS mcp_server_origin (
    server_id TEXT PRIMARY KEY,
    extension_root TEXT NOT NULL,
    source_file TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (server_id) REFERENCES mcp_server(server_id)
);

-- Personal memories are versioned facts, not Capability definitions. Their
-- operating tools live in /personal/memory and enter the normal ToolRuntime.
CREATE TABLE IF NOT EXISTS personal_memory_definition (
    memory_id TEXT NOT NULL,
    definition_version INTEGER NOT NULL,
    title TEXT NOT NULL,
    content_object_ref TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    scope TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_ref TEXT,
    confidence REAL NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (memory_id, definition_version)
);

CREATE TABLE IF NOT EXISTS personal_memory_head (
    memory_id TEXT PRIMARY KEY,
    definition_version INTEGER NOT NULL,
    lifecycle_status TEXT NOT NULL,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (memory_id, definition_version)
        REFERENCES personal_memory_definition(memory_id, definition_version)
);

CREATE INDEX IF NOT EXISTS idx_personal_memory_head_status
    ON personal_memory_head(lifecycle_status, updated_at);

CREATE INDEX IF NOT EXISTS idx_tool_user_input_waiting
    ON tool_user_input_request(status, expires_at);

CREATE TABLE IF NOT EXISTS user_input_attention_link (
    input_request_id TEXT PRIMARY KEY,
    attention_id TEXT NOT NULL UNIQUE,
    node_id TEXT NOT NULL UNIQUE,
    FOREIGN KEY (input_request_id)
        REFERENCES tool_user_input_request(input_request_id),
    FOREIGN KEY (node_id) REFERENCES render_node_projection(node_id)
);

CREATE TABLE IF NOT EXISTS tool_evidence (
    evidence_id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    kind TEXT NOT NULL,
    reference TEXT,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (execution_id, ordinal),
    FOREIGN KEY (execution_id) REFERENCES tool_execution(execution_id)
);

CREATE TABLE IF NOT EXISTS model_attempt (
    attempt_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    round_id TEXT NOT NULL,
    attempt_index INTEGER NOT NULL,
    provider_profile TEXT NOT NULL,
    model_id TEXT NOT NULL,
    context_hash TEXT NOT NULL,
    capability_lease_hash TEXT NOT NULL,
    phase TEXT NOT NULL,
    stop_reason TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    error_category TEXT,
    version INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    UNIQUE (round_id, attempt_index),
    FOREIGN KEY (conversation_id) REFERENCES iris_conversation(conversation_id),
    FOREIGN KEY (turn_id) REFERENCES conversation_turn(turn_id),
    FOREIGN KEY (run_id) REFERENCES agent_run(run_id),
    FOREIGN KEY (round_id) REFERENCES agent_round(round_id)
);

CREATE TABLE IF NOT EXISTS model_attempt_failure_detail (
    attempt_id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    provider_status INTEGER,
    provider_code TEXT,
    provider_type TEXT,
    diagnostic_message TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (attempt_id) REFERENCES model_attempt(attempt_id)
);

CREATE TABLE IF NOT EXISTS model_context_snapshot (
    context_hash TEXT PRIMARY KEY,
    capability_lease_hash TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    round_id TEXT NOT NULL,
    estimated_input_tokens INTEGER NOT NULL,
    max_input_tokens INTEGER NOT NULL,
    reserved_output_tokens INTEGER NOT NULL,
    dropped_fact_count INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES iris_conversation(conversation_id),
    FOREIGN KEY (run_id) REFERENCES agent_run(run_id),
    FOREIGN KEY (round_id) REFERENCES agent_round(round_id)
);

CREATE TABLE IF NOT EXISTS model_context_prefix (
    context_hash TEXT PRIMARY KEY,
    prompt_definition_id TEXT NOT NULL,
    prompt_version INTEGER NOT NULL,
    prompt_hash TEXT NOT NULL,
    tool_schema_hash TEXT NOT NULL,
    prefix_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (context_hash)
        REFERENCES model_context_snapshot(context_hash)
);

CREATE INDEX IF NOT EXISTS idx_model_context_prefix_hash
    ON model_context_prefix(prefix_hash);

CREATE TABLE IF NOT EXISTS model_attempt_usage (
    attempt_id TEXT PRIMARY KEY,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL,
    cache_miss_tokens INTEGER NOT NULL,
    reasoning_tokens INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (attempt_id) REFERENCES model_attempt(attempt_id)
);

CREATE VIEW IF NOT EXISTS model_attempt_cache_diagnostic AS
WITH ordered AS (
    SELECT
        ma.attempt_id,
        ma.run_id,
        ma.round_id,
        ar.round_index,
        ma.attempt_index,
        p.prompt_definition_id,
        p.prompt_version,
        p.prompt_hash,
        p.tool_schema_hash,
        p.prefix_hash,
        LAG(p.prompt_hash) OVER request_order AS previous_prompt_hash,
        LAG(p.tool_schema_hash) OVER request_order
            AS previous_tool_schema_hash,
        LAG(p.prefix_hash) OVER request_order AS previous_prefix_hash
    FROM model_attempt ma
    JOIN agent_round ar ON ar.round_id = ma.round_id
    JOIN model_context_prefix p ON p.context_hash = ma.context_hash
    WINDOW request_order AS (
        PARTITION BY ma.run_id
        ORDER BY ar.round_index, ma.attempt_index
    )
)
SELECT
    ordered.*,
    usage.input_tokens,
    usage.output_tokens,
    usage.cache_read_tokens,
    usage.cache_miss_tokens,
    usage.reasoning_tokens,
    CASE
        WHEN usage.cache_read_tokens + usage.cache_miss_tokens = 0 THEN NULL
        ELSE CAST(usage.cache_read_tokens AS REAL)
            / (usage.cache_read_tokens + usage.cache_miss_tokens)
    END AS cache_read_ratio,
    CASE
        WHEN ordered.previous_prefix_hash IS NULL THEN NULL
        WHEN ordered.previous_prefix_hash = ordered.prefix_hash THEN 0
        ELSE 1
    END AS prefix_changed,
    CASE
        WHEN ordered.previous_prompt_hash IS NULL THEN NULL
        WHEN ordered.previous_prompt_hash = ordered.prompt_hash THEN 0
        ELSE 1
    END AS prompt_changed,
    CASE
        WHEN ordered.previous_tool_schema_hash IS NULL THEN NULL
        WHEN ordered.previous_tool_schema_hash = ordered.tool_schema_hash THEN 0
        ELSE 1
    END AS tool_schema_changed
FROM ordered
LEFT JOIN model_attempt_usage usage
  ON usage.attempt_id = ordered.attempt_id;

CREATE TABLE IF NOT EXISTS model_capability_exposure (
    exposure_id TEXT PRIMARY KEY,
    context_hash TEXT NOT NULL,
    capability_lease_hash TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    manifest_hash TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (context_hash, tool_name),
    UNIQUE (context_hash, ordinal),
    FOREIGN KEY (context_hash)
        REFERENCES model_context_snapshot(context_hash)
);

CREATE TABLE IF NOT EXISTS model_content_block (
    block_id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL,
    block_index INTEGER NOT NULL,
    block_kind TEXT NOT NULL,
    provider_block_id TEXT,
    text_content TEXT,
    tool_name TEXT,
    tool_arguments_json TEXT,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (attempt_id, block_index),
    FOREIGN KEY (attempt_id) REFERENCES model_attempt(attempt_id)
);

CREATE TABLE IF NOT EXISTS model_tool_call (
    tool_call_id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL,
    block_id TEXT NOT NULL UNIQUE,
    provider_call_id TEXT,
    tool_name TEXT NOT NULL,
    arguments_json TEXT NOT NULL,
    arguments_hash TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    execution_id TEXT UNIQUE,
    created_at TEXT NOT NULL,
    UNIQUE (attempt_id, ordinal),
    FOREIGN KEY (attempt_id) REFERENCES model_attempt(attempt_id),
    FOREIGN KEY (block_id) REFERENCES model_content_block(block_id),
    FOREIGN KEY (execution_id) REFERENCES tool_execution(execution_id)
);

CREATE TABLE IF NOT EXISTS model_tool_call_exposure (
    tool_call_id TEXT PRIMARY KEY,
    exposure_id TEXT NOT NULL,
    FOREIGN KEY (tool_call_id) REFERENCES model_tool_call(tool_call_id),
    FOREIGN KEY (exposure_id)
        REFERENCES model_capability_exposure(exposure_id)
);

CREATE TABLE IF NOT EXISTS model_tool_call_resolution (
    tool_call_id TEXT PRIMARY KEY,
    proxy_tool_name TEXT NOT NULL,
    target_tool_name TEXT NOT NULL,
    target_capability_path TEXT NOT NULL,
    target_manifest_hash TEXT NOT NULL,
    target_arguments_json TEXT NOT NULL,
    target_arguments_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (tool_call_id) REFERENCES model_tool_call(tool_call_id)
);

CREATE TABLE IF NOT EXISTS tool_observation (
    observation_id TEXT PRIMARY KEY,
    tool_call_id TEXT NOT NULL UNIQUE,
    execution_id TEXT NOT NULL UNIQUE,
    outcome_kind TEXT NOT NULL,
    content_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (tool_call_id) REFERENCES model_tool_call(tool_call_id),
    FOREIGN KEY (execution_id) REFERENCES tool_execution(execution_id)
);

CREATE TABLE IF NOT EXISTS tool_observation_retention_decision (
    observation_id TEXT PRIMARY KEY,
    execution_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (observation_id)
        REFERENCES tool_observation(observation_id),
    FOREIGN KEY (execution_id)
        REFERENCES tool_execution(execution_id)
);
