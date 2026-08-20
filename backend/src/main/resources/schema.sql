PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

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

-- Link from a child/pipeline Run back to the `run` render node that represents it
-- inside the parent timeline. Kept separate from tool_render_link because a Run
-- can outlive its originating tool card and may be referenced by future updates.
CREATE TABLE IF NOT EXISTS child_run_render_link (
    child_run_id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL UNIQUE,
    FOREIGN KEY (child_run_id) REFERENCES agent_run(run_id),
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

CREATE TABLE IF NOT EXISTS capability_pin (
    path TEXT PRIMARY KEY,
    ordinal INTEGER NOT NULL,
    created_at TEXT NOT NULL
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

-- Cron schedule truth (docs/33 §2)。这两张表是持久真相；进程内定时器
-- 只是唤醒器，重启后按 next_fire_at 补扫。启用任务的 next_fire_at
-- 恒非空；触发时先把 next_fire_at 推进到下一棒再执行，进程崩溃最多
-- 漏掉当前这一棒，不会重复触发同一棒。
-- once=1 表示单次任务：到点触发一次后自动停用，错过即不再补跑。
CREATE TABLE IF NOT EXISTS cron_task (
    task_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    expression TEXT NOT NULL,
    prompt TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    once INTEGER NOT NULL DEFAULT 0,
    next_fire_at TEXT,
    last_fire_at TEXT,
    fire_count INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cron_execution (
    execution_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    trigger_kind TEXT NOT NULL,
    fired_at TEXT NOT NULL,
    conversation_id TEXT,
    run_id TEXT,
    status TEXT NOT NULL,
    error TEXT,
    FOREIGN KEY (task_id) REFERENCES cron_task(task_id)
);

CREATE INDEX IF NOT EXISTS idx_cron_execution_task
    ON cron_execution(task_id, fired_at);
