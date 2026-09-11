import { create } from 'zustand'
import {
  mcpMarketApi,
  type McpCredentialsPatch,
  type McpInstallRequest,
  type McpMarketCard,
  type McpMarketDetail,
  type McpServerStatus,
  type McpSettingsPatch,
} from '@/api/mcpMarketApi'
import { invalidateCapabilityIndex, warmCapabilityIndex } from '@/services/capabilityFs'

/**
 * MCP 插件市场状态（2026-08-06 市场 P1）。
 * 市场搜索/详情与已安装 server 两块数据；上游不可达（503）单独落 upstreamDown，
 * 视图层据此给降级提示而不是普通错误横幅（内网部署属预期形态）。
 * 2026-08-07 用户拍板：MCP 与管理员提权解耦，写操作不再可能 403（后端闸门已删）。
 */

/**
 * 竞态守卫（模块级）：
 * - searchSeq：搜索/加载更多序号，旧响应一律丢弃（防抖间隙快速改词时旧结果不得覆盖新结果，C3）。
 * - loadServersSeq：状态拉取序号，同理只应用最后一次响应。
 * - removedNames：删除成功后登记——删除前已发出的 in-flight loadServers 响应里仍含该 server，
 *   直接落库会让僵尸复活（C4）；同名重装（install）时解除登记。
 */
let searchSeq = 0
let loadServersSeq = 0
let detailSeq = 0
const removedNames = new Set<string>()

interface McpMarketState {
  // 市场搜索
  query: string
  items: McpMarketCard[]
  nextCursor: string | null
  isSearching: boolean
  isLoadingMore: boolean
  upstreamDown: boolean
  searchError: string | null
  hasSearched: boolean

  // 详情
  detailName: string | null
  detail: McpMarketDetail | null
  /** 打量面板即时快照（2026-08-08）：点卡瞬间用货架卡数据渲染头与描述，
   *  detail 往返期间用户读到的已是真实内容而非骨架；触点②直达路径无快照则骨架 */
  detailSnapshot: McpMarketCard | null
  isLoadingDetail: boolean

  // 已安装
  servers: McpServerStatus[]
  isLoadingServers: boolean

  search: (query: string) => Promise<void>
  loadMore: () => Promise<void>
  openDetail: (name: string, snapshot?: McpMarketCard) => Promise<void>
  closeDetail: () => void
  install: (body: McpInstallRequest) => Promise<string>
  loadServers: () => Promise<void>
  deleteServer: (name: string) => Promise<void>
  reconnectServer: (name: string) => Promise<void>
  updateCredentials: (name: string, patch: McpCredentialsPatch) => Promise<void>
  /** server 级设置增量（2026-08-07）：requiresApproval=false 免审批 / null 恢复缺省（opt-in 拍板）；
   *  enabled=false 停用下线 / true|null 恢复启用（v12 行开关）。两字段至少给一。 */
  updateSettings: (name: string, patch: McpSettingsPatch) => Promise<void>
}

export const useMcpMarketStore = create<McpMarketState>()((set, get) => {
  /**
   * 等指定 server 到达 Connected 后预热能力目录索引（一次性有界等待，非常驻轮询）。
   * install/reconnect 返回时后端热重连才刚开始（reloadOnChange 异步触发），此刻预热会
   * 缓存"目录尚无新工具"的中间态快照、污染整段会话，必须等状态到 Connected 再拉。
   * 有界且由用户操作触发：server 失败/被删/超时一律静默放弃——下次 grep 时惰性重拉兜底（2026-08-07 P2）。
   *
   * 2026-08-08 卡死修复（用户实测"正在接通一直不消，要手动刷新"）：
   * - 节奏 2s×5 + 5s×6 + 10s×3（总 ~70s）：首次 stdio 拉起常要下载运行时/npx 包，远超 10s，
   *   旧窗口耗尽后行态永远停在"正在接通"；70s 盖住后端自身的 connect 超时
   *   （ConnectTimeout=30s，超时翻 Failed），让行态最终落到"已接通"或"连接失败"；
   *   过程感不靠拉长时间——行内微光轨动画（wf-conn-track）承担"还在动"的信号
   * - 提前放弃只认 Failed：enable 后头几次轮询后端可能还回旧的 Disconnected
   *   （reloadOnChange 去抖未生效），旧逻辑一见 Disconnected 就整体放弃 → 同样卡死。
   */
  const waitConnectedThenWarmIndex = async (name: string) => {
    const waits = [2000, 2000, 2000, 2000, 2000, 5000, 5000, 5000, 5000, 5000, 5000, 10000, 10000, 10000]
    for (const ms of waits) {
      await new Promise((r) => setTimeout(r, ms))
      await get().loadServers()
      const s = get().servers.find((x) => x.name === name)
      if (!s || s.state === 'Failed') return
      if (s.state === 'Connected') {
        warmCapabilityIndex()
        return
      }
    }
  }

  return {
  query: '',
  items: [],
  nextCursor: null,
  isSearching: false,
  isLoadingMore: false,
  upstreamDown: false,
  searchError: null,
  hasSearched: false,

  detailName: null,
  detail: null,
  detailSnapshot: null,
  isLoadingDetail: false,

  servers: [],
  isLoadingServers: false,

  search: async (query) => {
    const seq = ++searchSeq
    set({ isSearching: true, searchError: null, upstreamDown: false, query, hasSearched: true })
    try {
      const result = await mcpMarketApi.search(query)
      if (seq !== searchSeq) return // 已有更新的搜索发出，旧响应丢弃
      set({ items: result.items, nextCursor: result.nextCursor })
    } catch (err: any) {
      if (seq !== searchSeq) return
      if (err?.status === 503) {
        set({ upstreamDown: true, items: [], nextCursor: null })
      } else {
        set({ searchError: err?.message || '搜索失败', items: [], nextCursor: null })
      }
    } finally {
      if (seq === searchSeq) set({ isSearching: false })
    }
  },

  loadMore: async () => {
    const { nextCursor, query, isLoadingMore } = get()
    if (!nextCursor || isLoadingMore) return
    const seq = searchSeq // 追加只对当前这次搜索的结果集有意义
    set({ isLoadingMore: true })
    try {
      const result = await mcpMarketApi.search(query, nextCursor)
      if (seq !== searchSeq) return // 追加期间发生了新搜索，丢弃（新结果集已整体替换 items）
      // 用最新态追加：响应在途期间 items 可能已被其他路径更新
      set({ items: [...get().items, ...result.items], nextCursor: result.nextCursor })
    } catch (err: any) {
      set({ searchError: err?.message || '加载失败' })
    } finally {
      set({ isLoadingMore: false })
    }
  },

  openDetail: async (name, snapshot) => {
    // 序号守卫：连点两张卡时慢的旧响应不得覆盖新 detail（与 searchSeq 同纪律）
    const seq = ++detailSeq
    set({ detailName: name, detail: null, detailSnapshot: snapshot ?? null, isLoadingDetail: true })
    try {
      const detail = await mcpMarketApi.detail(name)
      if (seq !== detailSeq) return
      set({ detail })
    } catch {
      // 详情失败时抽屉仍打开，视图层显示加载失败占位
      if (seq !== detailSeq) return
      set({ detail: null })
    } finally {
      if (seq === detailSeq) set({ isLoadingDetail: false })
    }
  },

  closeDetail: () => {
    detailSeq++ // 作废旧响应：面板关闭后迟到的 detail 不得落库
    set({ detailName: null, detail: null, detailSnapshot: null })
  },

  install: async (body) => {
    const result = await mcpMarketApi.install(body)
    removedNames.delete(result.serverName) // 同名重装：解除删除登记
    // 能力目录索引是会话级缓存（capabilityFs）：安装让后端目录新增 mcp__ 工具，
    // 必须失效索引，否则模型 grep /capabilities 永远命中不到新装工具（2026-08-07 P2）。
    // 先立即失效防旧快照继续被用；重拉不在这里做——后端热重连是异步的，
    // 等 Connected 后由 waitConnectedThenWarmIndex 预热（符合"用户操作时再尝试"）。
    invalidateCapabilityIndex()
    void get().loadServers()
    void waitConnectedThenWarmIndex(result.serverName)
    return result.serverName
  },

  loadServers: async () => {
    const seq = ++loadServersSeq
    set({ isLoadingServers: true })
    try {
      const { servers } = await mcpMarketApi.getServerStatuses()
      if (seq !== loadServersSeq) return // 只应用最后一次响应
      // 过滤删除登记：本响应可能是删除完成前发出的，含已删 server（僵尸复活防线）
      set({ servers: servers.filter((s) => !removedNames.has(s.name)) })
      removedNames.clear()
    } catch {
      // 状态读取失败保持旧数据，不打断浏览
    } finally {
      if (seq === loadServersSeq) set({ isLoadingServers: false })
    }
  },

  deleteServer: async (name) => {
    await mcpMarketApi.deleteServer(name)
    removedNames.add(name) // 防 in-flight loadServers 旧快照回魂
    // 删除后端同步生效（disconnect+注销工具），立即失效并重拉是安全的——
    // 避免索引里的 mcp__ 条目成僵尸（grep 命中但 read_capability 404），
    // 顺带省掉下次 grep 的等待
    invalidateCapabilityIndex()
    warmCapabilityIndex()
    set({ servers: get().servers.filter((s) => s.name !== name) })
  },

  reconnectServer: async (name) => {
    await mcpMarketApi.reconnectServer(name)
    // 重连可能改变该 server 的工具集（远端 list_changed）：先失效旧快照，
    // 再等 Connected 后预热（与 install 同一纪律）
    invalidateCapabilityIndex()
    void get().loadServers()
    void waitConnectedThenWarmIndex(name)
  },

  updateCredentials: async (name, patch) => {
    await mcpMarketApi.updateCredentials(name, patch)
    // 凭据变化触发后端热重连（ConfigHash 变化）：工具集一般不变，
    // 但重连失败会 Failed——同 install 纪律等 Connected 后让状态落定
    void get().loadServers()
    void waitConnectedThenWarmIndex(name)
  },

  updateSettings: async (name, patch) => {
    // 乐观行态先行（2026-08-08 死时间修复）：旧写法先 await PATCH 往返再 set，
    // 点击后行态要卡 ~150-200ms 才翻转——开关手感=点了没反应。先 set 后 await，
    // 失败整体回滚到点击前的行态。
    const prevRow = patch.enabled !== undefined ? get().servers.find((s) => s.name === name) : null
    if (patch.enabled !== undefined) {
      // 作废旧响应（2026-08-08 竞态修复）：点击前发出的 loadServers 可能还在途，
      // 其响应是点击前的旧快照，落定会把乐观行态打回原样（v15c 实测：PATCH 已成功
      // 但行态被在途 GET 覆盖，看上去"点了没反应"）。 bump 序号让它们一律被守卫丢弃，
      // 只有点击后发出的 loadServers 有权落定
      loadServersSeq++
      const enabling = patch.enabled !== false
      set({
        servers: get().servers.map((s) =>
          s.name === name
            ? { ...s, enabled: enabling, state: enabling ? 'Connecting' : 'Disconnected' }
            : s
        ),
      })
    }
    try {
      await mcpMarketApi.updateSettings(name, patch)
    } catch (err) {
      if (prevRow) {
        set({ servers: get().servers.map((s) => (s.name === name ? prevRow : s)) })
      }
      throw err
    }
    // metadata/enabled 均进 ConfigHash → 后端自动热重连：
    // - requiresApproval 翻转 → 工具 descriptor 的 approvalMode 翻转，目录 markdown 里的「审批」行是旧快照；
    // - enabled=false → slot 下线工具注销（grep 不再命中）；enabled=true → 新 slot 重连。
    // 都必须失效索引+等状态落定后预热（同 install 纪律）。
    // 注意：本会话已通过 read_capability 加载进执行镜像的工具条目不会回溯更新，
    // 该 server 工具的免审批对"新读取/新对话"立即生效，已加载条目等下次 read_capability 刷新
    invalidateCapabilityIndex()
    void get().loadServers()
    // 停用是立即终态（行态已乐观翻转），不需要等 Connected；启用/策略翻转才等热重连落定
    if (patch.enabled !== false) void waitConnectedThenWarmIndex(name)
  },
  }
})
