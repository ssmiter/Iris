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
('mes','aps','schedule','APS-SCHEDULE-0730-01','2026-07-30','PRODUCT-X1','通用制品 X1','LINE-GROUP-A','feasible',600,600,'piece','high','{"bottleneck":"curing","estimatedCompletion":"2026-07-31T16:00:00Z"}','2026-07-29T09:04:00Z');

INSERT OR IGNORE INTO industrial_demo_reference_object VALUES
('mes','recipe','RCP-C11','通用胶料 C11 配方','mixing','3.2','active','MX-03','{"componentCount":7,"approved":true}','2026-07-28T12:00:00Z'),
('mes','recipe','RCP-C12','通用胶料 C12 配方','mixing','2.5','active','MX-04','{"componentCount":8,"approved":true}','2026-07-27T11:00:00Z'),
('mes','mould','MOULD-X1-A','X1 通用模具 A','curing','1','in_use','CU-02','{"ratedCycles":8000,"usedCycles":5240,"maintenanceDueCycles":6000}','2026-07-29T08:40:00Z'),
('mes','mould','MOULD-X2-B','X2 通用模具 B','curing','1','available','MOULD-RACK-02','{"ratedCycles":7500,"usedCycles":3190,"maintenanceDueCycles":5000}','2026-07-29T08:42:00Z');

CREATE TABLE IF NOT EXISTS iris_conversation (
    conversation_id TEXT PRIMARY KEY,
    root_branch_id TEXT NOT NULL,
    title TEXT,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
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
