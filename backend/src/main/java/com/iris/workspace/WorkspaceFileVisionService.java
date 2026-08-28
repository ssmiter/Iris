package com.iris.workspace;

import com.iris.tools.core.ToolRuntimeException;
import org.springframework.stereotype.Service;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

/**
 * 读改写状态机（docs/42 §4-8）：按会话记录「模型视野里的文件内容版本」，
 * 编辑类工具执行前校验「先读过且文件未被别人改过」，过期即拒绝并要求重读。
 *
 * <p>审批管线管「要不要写」，这套状态机管「不基于过期视野写」。</p>
 *
 * <p>状态放内存而不落盘，理由：它回答的是「当前模型视野是否新鲜」，
 * 进程重启后磁盘内容可能已被外部改动，清空状态迫使重启后的首次改写
 * 先重读——这是 fail-close 方向；持久化反而会把「曾经读过」误当
 * 「视野仍然新鲜」。比对用 SHA-256 内容摘要而非 mtime+size：内容相同
 * 才是视野未过期，mtime 变了内容没变不应误拒，同 size 同 mtime 但
 * 内容不同必须拒。容量有界，驱逐只导致多一次重读，不会错放行。</p>
 */
@Service
public class WorkspaceFileVisionService {

    private static final int MAX_TRACKED_CONVERSATIONS = 1_000;
    private static final int MAX_TRACKED_PATHS_PER_CONVERSATION = 512;

    private final Map<String, ConversationVision> visions =
            new LinkedHashMap<>(16, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(
                        Map.Entry<String, ConversationVision> eldest
                ) {
                    return size() > MAX_TRACKED_CONVERSATIONS;
                }
            };

    /** 当前会话对 path 的最近一次视野记录。 */
    public synchronized Optional<VisionMark> markOf(
            String conversationId,
            String path
    ) {
        return Optional.ofNullable(visions.get(conversationId))
                .map(vision -> vision.marks.get(path));
    }

    /**
     * 是否「同文件同区间重复读取且文件未变」：
     * 区间一致、内容摘要一致，且该区间确实来自一次读取而非写入推进。
     */
    public synchronized boolean matchesLastRead(
            String conversationId,
            String path,
            String contentHash,
            int startLine,
            int lineCount
    ) {
        return markOf(conversationId, path)
                .filter(mark -> mark.startLine() == startLine
                        && mark.lineCount() == lineCount
                        && mark.contentHash().equals(contentHash))
                .isPresent();
    }

    /** read_file 成功返回后登记视野：内容摘要 + 本次读取区间。 */
    public synchronized void recordRead(
            String conversationId,
            String path,
            String contentHash,
            int startLine,
            int lineCount
    ) {
        conversation(conversationId).marks.put(
                path,
                new VisionMark(contentHash, startLine, lineCount)
        );
    }

    /**
     * 本会话工具写入成功后推进视野：摘要前进到写后版本，
     * 读取区间作废（模型尚未看到新内容，重复读取 stub 不得命中）。
     */
    public synchronized void recordWritten(
            String conversationId,
            String path,
            String afterHash
    ) {
        conversation(conversationId).marks.put(
                path,
                new VisionMark(afterHash, 0, 0)
        );
    }

    /** move_file 成功后迁移视野：内容未变，路径换了。 */
    public synchronized void recordMoved(
            String conversationId,
            String sourcePath,
            String destinationPath,
            String destinationHash
    ) {
        ConversationVision vision = conversation(conversationId);
        vision.marks.remove(sourcePath);
        vision.marks.put(
                destinationPath,
                new VisionMark(destinationHash, 0, 0)
        );
    }

    /** delete_file 成功后清除视野：路径已不存在。 */
    public synchronized void recordDeleted(String conversationId, String path) {
        ConversationVision vision = visions.get(conversationId);
        if (vision != null) {
            vision.marks.remove(path);
        }
    }

    /**
     * 编辑类工具执行前校验。新建文件（目标不存在）不受「先读过」约束；
     * 已存在文件必须先在本会话读过，且当前内容摘要与读取时一致。
     * 拒绝发生在任何写入之前，消息按「错误即教学」给出下一步。
     */
    public synchronized void requireFreshVision(
            String conversationId,
            String path,
            boolean targetExists,
            String currentHash
    ) {
        if (!targetExists) {
            return;
        }
        Optional<VisionMark> mark = markOf(conversationId, path);
        if (mark.isEmpty()) {
            throw ToolRuntimeException.beforeCommit(
                    "workspace_edit_requires_read",
                    "本次对话还没有读过 " + path
                            + "；为避免基于猜测改写文件，请先用 read_file "
                            + "读取它，再按最新内容修改"
            );
        }
        if (!mark.get().contentHash().equals(currentHash)) {
            throw ToolRuntimeException.beforeCommit(
                    "workspace_vision_stale",
                    path + " 在你上次读取后已被改动；为避免基于过期内容改写，"
                            + "请先用 read_file 重读最新内容，再按新原文修改"
            );
        }
    }

    private ConversationVision conversation(String conversationId) {
        return visions.computeIfAbsent(
                conversationId,
                key -> new ConversationVision()
        );
    }

    /**
     * startLine/lineCount 为 0 表示视野来自写入推进而非读取，
     * 此时只有内容摘要有效，重复读取 stub 不命中。
     */
    public record VisionMark(String contentHash, int startLine, int lineCount) {
    }

    private static final class ConversationVision {
        private final Map<String, VisionMark> marks =
                new LinkedHashMap<>(16, 0.75f, true) {
                    @Override
                    protected boolean removeEldestEntry(
                            Map.Entry<String, VisionMark> eldest
                    ) {
                        return size() > MAX_TRACKED_PATHS_PER_CONVERSATION;
                    }
                };
    }
}
