PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

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
