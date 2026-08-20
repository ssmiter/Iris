package com.iris.tools.catalog;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 目录生成号单调性（docs/37 §2.5）：进程内计数器从零开始，
 * bump 返回值严格递增且 current 实时反映最新值。
 */
class CatalogGenerationServiceTest {

    @Test
    void currentStartsAtZero() {
        CatalogGenerationService service = new CatalogGenerationService();
        assertEquals(0L, service.current());
    }

    @Test
    void bumpReturnsMonotonicallyIncreasingValues() {
        CatalogGenerationService service = new CatalogGenerationService();

        long first = service.bump();
        long second = service.bump();
        long third = service.bump();

        assertEquals(1L, first);
        assertEquals(2L, second);
        assertEquals(3L, third);
        assertTrue(first < second && second < third);
        assertEquals(third, service.current());
    }
}
