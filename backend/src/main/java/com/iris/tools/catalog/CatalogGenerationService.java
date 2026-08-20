package com.iris.tools.catalog;

import org.springframework.stereotype.Service;

import java.util.concurrent.atomic.AtomicLong;

/**
 * 能力目录生成号：进程内单调计数器，用于前端管理页增量刷新探针
 * （docs/37 §2.5）。不持久化，重启归零。
 */
@Service
public class CatalogGenerationService {

    private final AtomicLong generation = new AtomicLong();

    public long current() {
        return generation.get();
    }

    public long bump() {
        return generation.incrementAndGet();
    }
}
