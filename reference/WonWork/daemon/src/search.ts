import { ensureBrowser } from './browser'
import { executeAction } from './actions'
import type { Client } from 'chrome-remote-interface'

export interface SearchHit {
  title: string
  url: string
  snippet?: string
  displayUrl?: string
}

export interface SearchResponse {
  success: boolean
  query: string
  engine: string
  results: SearchHit[]
  error?: string
}

interface BrowserOptions {
  browserPath?: string
  headless?: boolean
}

function getBrowserOptions(): BrowserOptions {
  return {
    browserPath: process.env.WEBBRIDGE_BROWSER_PATH,
    headless: process.env.WEBBRIDGE_HEADLESS === 'true',
  }
}

async function navigateTo(client: Client, url: string, timeoutMs = 30000): Promise<void> {
  const result = await executeAction(client, {
    action_type: 'navigate',
    value: url,
    timeout_ms: timeoutMs,
  })
  if (!result.success) {
    throw new Error(result.error_message || `Navigation to ${url} failed`)
  }
}

async function extractSearchResults(client: Client, script: string): Promise<SearchHit[]> {
  const result = await executeAction(client, {
    action_type: 'evaluate',
    value: script,
  })
  if (!result.success) {
    throw new Error(result.error_message || 'Failed to extract search results')
  }
  const items = Array.isArray(result.data) ? (result.data as SearchHit[]) : []
  return items.filter((item) => item.title && item.url)
}

async function waitForResults(client: Client, selector: string, timeoutMs = 5000): Promise<void> {
  try {
    const result = await executeAction(client, {
      action_type: 'wait_for_element',
      selector: { selector_type: 'css', value: selector },
      delay_ms: timeoutMs,
    })
    if (!result.success) {
      throw new Error(result.error_message || 'Wait for results failed')
    }
  } catch {
    // 即使等待失败也继续提取；可能页面已加载但结构不同
  }
}

async function searchDuckDuckGo(client: Client, query: string, topN: number): Promise<SearchHit[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  await navigateTo(client, url)
  await waitForResults(client, '.result__a')
  await executeAction(client, { action_type: 'wait', delay_ms: 500 })

  const script = `(() => {
    const hits = []
    const blocks = document.querySelectorAll('.result')
    blocks.forEach(block => {
      const link = block.querySelector('a.result__a')
      const snippet = block.querySelector('.result__snippet')
      const site = block.querySelector('.result__url__domain') || block.querySelector('a.result__url')
      if (!link) return
      hits.push({
        title: (link.textContent || '').trim(),
        url: link.href,
        snippet: snippet ? (snippet.textContent || '').trim() : '',
        displayUrl: site ? (site.textContent || '').trim() : ''
      })
    })
    return hits
  })()`

  const results = await extractSearchResults(client, script)
  return results.slice(0, topN)
}

async function searchBing(client: Client, query: string, topN: number): Promise<SearchHit[]> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`
  await navigateTo(client, url)
  await waitForResults(client, 'li.b_algo')
  await executeAction(client, { action_type: 'wait', delay_ms: 1000 })

  const script = `(() => {
    const hits = []
    const blocks = document.querySelectorAll('li.b_algo')
    blocks.forEach(block => {
      const link = block.querySelector('h2 a') || block.querySelector('a')
      const snippet = block.querySelector('p') || block.querySelector('.b_caption p')
      const cite = block.querySelector('cite')
      if (!link) return
      hits.push({
        title: (link.textContent || '').trim(),
        url: link.href,
        snippet: snippet ? (snippet.textContent || '').trim() : '',
        displayUrl: cite ? (cite.textContent || '').trim() : ''
      })
    })
    return hits
  })()`

  const results = await extractSearchResults(client, script)
  return results.slice(0, topN)
}

export async function performSearch(query: string, topN = 10): Promise<SearchResponse> {
  if (!query || !query.trim()) {
    return { success: false, query, engine: '', results: [], error: 'Query is required' }
  }

  const client = await ensureBrowser(getBrowserOptions())

  try {
    let results = await searchDuckDuckGo(client, query, topN)
    let engine = 'duckduckgo'

    if (results.length === 0) {
      results = await searchBing(client, query, topN)
      engine = 'bing'
    }

    return { success: true, query, engine, results }
  } catch (err) {
    return {
      success: false,
      query,
      engine: '',
      results: [],
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
