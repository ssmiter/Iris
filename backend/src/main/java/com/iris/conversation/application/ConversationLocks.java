package com.iris.conversation.application;

import org.springframework.stereotype.Component;

import java.util.concurrent.locks.ReentrantLock;

@Component
public final class ConversationLocks {
    private static final int STRIPE_COUNT = 64;
    private final ReentrantLock[] stripes = new ReentrantLock[STRIPE_COUNT];

    public ConversationLocks() {
        for (int index = 0; index < stripes.length; index++) {
            stripes[index] = new ReentrantLock();
        }
    }

    public <T> T withLock(String key, LockedSupplier<T> supplier) {
        ReentrantLock lock = stripes[Math.floorMod(key.hashCode(), stripes.length)];
        lock.lock();
        try {
            return supplier.get();
        } finally {
            lock.unlock();
        }
    }

    @FunctionalInterface
    public interface LockedSupplier<T> {
        T get();
    }
}
