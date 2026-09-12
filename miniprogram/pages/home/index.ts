import {
  CATEGORY_OPTIONS,
  DEFAULT_INVENTORY_SORT,
  hasActiveInventoryConditions,
  HOME_CARD_VIEW_STATUS,
  INVENTORY_SORT_OPTIONS,
  INVENTORY_VIEW_STATUS_OPTIONS,
  MAX_ITEM_QUANTITY,
  MAX_LIST_ITEMS,
  canLoadMoreItems,
  stepQuantity,
  toInventoryCardItem,
  type InventoryCardItem,
} from '../../domain/inventory'
import { CloudServiceError, getErrorMessage } from '../../services/cloud-client'
import {
  completeItem,
  deleteItem,
  getOverview,
  listInventory,
  onItemCoverReady,
  updateQuantity,
} from '../../services/inventory-service'
import type {
  Category,
  InventoryOverviewResult,
  InventorySort,
  InventoryViewStatus,
} from '../../types/inventory'
import { track } from '../../utils/analytics'
import { shanghaiTodayKey, millisecondsUntilShanghaiTomorrow } from '../../utils/shanghai-time'

interface MoreSheet {
  visible: boolean
  itemId: string
  name: string
}

// 到期提醒需要看得见任务状态才能决策，只在物品详情里操作，不放进这个看不见状态的快捷菜单。
type MoreAction = 'complete' | 'delete'

const OVERVIEW_STORAGE_KEY = 'home_overview_cache'

/**
 * 概览缓存：4 次 count 是首页最贵的一段，而从详情/编辑/批量页返回首页是高频动作，
 * 数据却大概率没变。这里做 SWR —— 进页面先用缓存渲染，再按需静默刷新。
 *
 * 失效条件有三条，缺一不可：
 * 1. 任何写操作（增删改、批量）后置脏标记；
 * 2. 缓存日期 ≠ 今天：跨日会让「临期 3 件」一直挂着昨天算出来的数字；
 * 3. `statsDirty` 由 refresh() 翻页时发现列表与缓存不一致时置位。
 */
interface OverviewCache {
  dateKey: string
  overview: InventoryOverviewResult
  at: number
}

let overviewCache: OverviewCache | null = null
let overviewDirty = true

/** 写操作后调用：下次进首页必须重新统计。 */
export function markOverviewDirty() {
  overviewDirty = true
}

function readOverviewCache(): OverviewCache | null {
  if (overviewCache) return overviewCache
  try {
    const stored = wx.getStorageSync(OVERVIEW_STORAGE_KEY) as OverviewCache | ''
    if (stored && typeof stored === 'object' && stored.overview && typeof stored.dateKey === 'string') {
      overviewCache = stored
    }
  } catch (_error) {
    // 读不到就当没有缓存，走正常请求
  }
  return overviewCache
}

function writeOverviewCache(overview: InventoryOverviewResult) {
  const next: OverviewCache = { dateKey: shanghaiTodayKey(), overview, at: Date.now() }
  overviewCache = next
  overviewDirty = false
  try {
    wx.setStorageSync(OVERVIEW_STORAGE_KEY, next)
  } catch (_error) {
    // 缓存写失败不影响本次展示
  }
}

function cachedOverviewUsable(dateKey: string): boolean {
  const cache = readOverviewCache()
  return Boolean(cache && !overviewDirty && cache.dateKey === dateKey)
}

let searchTimer: number | undefined
let midnightTimer: number | undefined
let listRequestSequence = 0
let overviewRequestSequence = 0
// 封面异步生成完成后回填卡片的订阅句柄（onShow 订阅 / onHide 退订，避免重复绑定）。
let coverUnsubscribe: (() => void) | null = null

function emptyMoreSheet(): MoreSheet {
  return { visible: false, itemId: '', name: '' }
}

Page({
  data: {
    headerTop: 48,
    titleWidth: 200,
    loading: true,
    refreshing: false,
    errorMessage: '',
    listErrorMessage: '',
    overview: null as InventoryOverviewResult | null,
    search: '',
    category: '' as Category | '',
    viewStatus: 'active_all' as InventoryViewStatus,
    sort: DEFAULT_INVENTORY_SORT as InventorySort,
    categoryOptions: CATEGORY_OPTIONS,
    statusOptions: INVENTORY_VIEW_STATUS_OPTIONS,
    sortOptions: INVENTORY_SORT_OPTIONS,
    items: [] as InventoryCardItem[],
    nextCursor: null as string | null,
    loadingMore: false,
    loadMoreError: '',
    hasActiveConditions: false,
    actionLoading: false,
    /** 到达单次加载上限（200 条）后停止自动翻页，提示用户改用搜索。 */
    loadMoreLimited: false,
    moreSheet: emptyMoreSheet(),
  },

  onLoad() {
    const windowInfo = wx.getWindowInfo()
    const capsule = wx.getMenuButtonBoundingClientRect()
    this.setData({
      headerTop: capsule.top || (windowInfo.statusBarHeight + 8),
      titleWidth: capsule.left > 0 ? capsule.left - 36 : windowInfo.windowWidth - 140,
    })
  },

  editMoreItem() {
    const itemId = this.data.moreSheet.itemId
    this.closeMore()
    wx.navigateTo({ url: `/pages/item-form/index?id=${itemId}` })
  },

  onShow() {
    this.syncTabBar()
    this.subscribeCoverUpdates()
    this.applyPendingHomeSort()
    // 先用缓存渲染概览，数据没脏且还是今天就不重复打云函数（4 次 count 是首页最贵的一段）。
    this.applyCachedOverview()
    void this.refresh(true, false)
    this.scheduleMidnightRefresh()
  },

  /** 有可用缓存就先顶上，弱网下首屏立刻有内容。 */
  applyCachedOverview() {
    const cache = readOverviewCache()
    if (!cache) return
    if (cache.dateKey !== shanghaiTodayKey()) return
    if (this.data.overview) return
    this.setData({ overview: cache.overview })
  },

  /** 任何改变了物品集合或状态的操作都要让概览缓存失效，否则返回首页会看到旧数字。 */
  invalidateOverview() {
    markOverviewDirty()
  },

  /** 保存物品后回首页的一次性排序意图：消费即清空，之后用户自己选的排序不受影响。 */
  applyPendingHomeSort() {
    const app = getApp<IAppOption>()
    const intent = app.globalData.pendingHomeSortIntent
    if (!intent) return
    app.globalData.pendingHomeSortIntent = null
    if (intent.sort === this.data.sort) return
    this.setData({ sort: intent.sort })
  },

  onHide() {
    this.unsubscribeCoverUpdates()
    if (searchTimer) clearTimeout(searchTimer)
    if (midnightTimer) clearTimeout(midnightTimer)
  },

  onUnload() {
    this.unsubscribeCoverUpdates()
    if (searchTimer) clearTimeout(searchTimer)
    if (midnightTimer) clearTimeout(midnightTimer)
  },

  // 保存物品时封面是后台生成的：返回首页的那一刻列表里还没有 coverFileId，
  // 等生图完成后把结果直接补到已渲染的卡片上，用户不必再手动下拉刷新。
  subscribeCoverUpdates() {
    if (coverUnsubscribe) return
    coverUnsubscribe = onItemCoverReady(({ itemId, coverFileId }) => {
      this.patchItem(itemId, { coverFileId })
    })
  },

  unsubscribeCoverUpdates() {
    if (!coverUnsubscribe) return
    coverUnsubscribe()
    coverUnsubscribe = null
  },

  onPullDownRefresh() {
    this.setData({ refreshing: true })
    // 下拉是用户明确的「我要最新数据」意图，必须穿透缓存。
    this.invalidateOverview()
    this.refresh(true, false).finally(() => {
      this.setData({ refreshing: false })
      wx.stopPullDownRefresh()
    })
  },

  onReachBottom() {
    if (!this.data.nextCursor || this.data.loading || this.data.loadingMore) return
    if (!canLoadMoreItems(this.data.items.length)) return
    void this.refresh(false, false)
  },

  scheduleMidnightRefresh() {
    if (midnightTimer) clearTimeout(midnightTimer)
    midnightTimer = setTimeout(() => {
      // 跨日了：概览缓存必然过期（dateKey 判定会挡住），这里顺手清一次脏标记再拉。
      this.invalidateOverview()
      void this.refresh(true, false)
      this.scheduleMidnightRefresh()
    }, millisecondsUntilShanghaiTomorrow()) as unknown as number
  },

  getTabBarInstance() {
    return (
      this as unknown as {
        getTabBar?: () =>
          | { data?: Record<string, unknown>; setData?: (data: Record<string, unknown>) => void }
          | undefined
      }
    ).getTabBar?.()
  },

  syncTabBar() {
    this.setTabBarHidden(false)
    this.getTabBarInstance()?.setData?.({ selected: 0 })
  },

  /* 弹窗打开时收起自定义标签栏：自定义标签栏由框架单独渲染，页面内的 z-index 无法盖住它 */
  setTabBarHidden(hidden: boolean) {
    const tabBar = this.getTabBarInstance()
    if (!tabBar?.data || tabBar.data.hidden === hidden) return
    tabBar.setData?.({ hidden })
  },

  /**
   * 概览兜底通道。正常路径下概览由 `listInventory` 首屏顺带回传，不需要单独调用；
   * 只有列表请求失败、页面上还没有可用概览时才走这里，避免「列表挂了首页一片空白」。
   */
  async refreshOverview(options: { force?: boolean } = {}) {
    // 数据没脏、还是同一天：直接用缓存，不打云函数。
    if (!options.force && cachedOverviewUsable(shanghaiTodayKey())) {
      this.applyCachedOverview()
      return
    }
    const requestSequence = ++overviewRequestSequence
    try {
      const overview = await getOverview()
      if (requestSequence !== overviewRequestSequence) return
      writeOverviewCache(overview)
      this.setData({ overview, errorMessage: '' })
    } catch (error) {
      if (requestSequence !== overviewRequestSequence) return
      if (this.data.overview) return
      this.setData({ errorMessage: getErrorMessage(error) })
    }
  },

  async refresh(reset: boolean, clearExisting: boolean) {
    const requestSequence = ++listRequestSequence
    const query = {
      search: this.data.search,
      category: this.data.category,
      viewStatus: this.data.viewStatus,
      sort: this.data.sort,
    }
    if (reset) {
      this.setData({
        loading: clearExisting || this.data.items.length === 0,
        listErrorMessage: '',
        loadMoreError: '',
        ...(clearExisting ? { items: [], nextCursor: null } : {}),
      })
    } else {
      this.setData({ loadingMore: true, loadMoreError: '' })
    }

    // 只有首屏且本地概览缓存不可用时才让云端顺带统计，否则纯属白算。
    const needOverview = reset && !cachedOverviewUsable(shanghaiTodayKey())
    try {
      const result = await listInventory({
        ...query,
        cursor: reset ? null : this.data.nextCursor,
        ...(needOverview ? { withOverview: true } : {}),
      })
      if (requestSequence !== listRequestSequence) return
      const pageItems = result.items.map(toInventoryCardItem)
      // 到上限后停止自动加载：列表没有虚拟化，节点数涨到几百条就会拖慢滚动。
      const capped = reset ? pageItems : [...this.data.items, ...pageItems].slice(0, MAX_LIST_ITEMS)
      const reachedLimit = capped.length >= MAX_LIST_ITEMS
      // 首屏顺带返回的概览：只有在缓存不可用（脏 / 跨日 / 首次）时才采纳，
      // 否则会用刚拉到的列表数据覆盖用户已有的正确缓存并触发多余渲染。
      const overviewPatch =
        needOverview && result.overview
          ? (writeOverviewCache(result.overview), { overview: result.overview, errorMessage: '' })
          : {}
      this.setData({
        items: capped,
        nextCursor: reachedLimit ? null : result.nextCursor,
        loadMoreLimited: reachedLimit,
        loading: false,
        loadingMore: false,
        listErrorMessage: '',
        loadMoreError: '',
        ...overviewPatch,
        hasActiveConditions: hasActiveInventoryConditions(
          query.search,
          query.category as Category | '',
          query.viewStatus,
        ),
      })
    } catch (error) {
      if (requestSequence !== listRequestSequence) return
      const message = getErrorMessage(error)
      if (!reset) {
        this.setData({ loadingMore: false, loadMoreError: `后续物品加载失败：${message}` })
        return
      }
      this.setData({
        loading: false,
        loadingMore: false,
        listErrorMessage: this.data.items.length ? `列表未更新：${message}` : message,
      })
      // 列表挂了不代表概览也拿不到：概览是首页顶部四张卡，能单独救回来就救。
      if (!this.data.overview) void this.refreshOverview({ force: true })
    }
  },

  applyFilters() {
    if (searchTimer) clearTimeout(searchTimer)
    this.setData(
      {
        hasActiveConditions: hasActiveInventoryConditions(
          this.data.search,
          this.data.category,
          this.data.viewStatus,
        ),
      },
      () => void this.refresh(true, true),
    )
  },

  handleSearchInput(event: WechatMiniprogram.Input) {
    this.setData({ search: event.detail.value })
    if (searchTimer) clearTimeout(searchTimer)
    searchTimer = setTimeout(() => this.applyFilters(), 300) as unknown as number
  },

  clearSearch() {
    this.setData({ search: '' }, () => this.applyFilters())
  },

  selectCategory(event: WechatMiniprogram.CustomEvent) {
    const category = event.currentTarget.dataset.value as Category | ''
    if (category === this.data.category) return
    this.setData({ category }, () => this.applyFilters())
  },

  selectStatus(event: WechatMiniprogram.CustomEvent) {
    const viewStatus = event.currentTarget.dataset.value as InventoryViewStatus
    if (viewStatus === this.data.viewStatus) return
    this.setData({ viewStatus }, () => this.applyFilters())
  },

  selectSort(event: WechatMiniprogram.CustomEvent) {
    const sort = event.currentTarget.dataset.value as InventorySort
    if (sort === this.data.sort) return
    this.setData({ sort }, () => this.applyFilters())
  },

  selectOverviewCard(event: WechatMiniprogram.CustomEvent) {
    const card = event.currentTarget.dataset.card as keyof typeof HOME_CARD_VIEW_STATUS
    const viewStatus = HOME_CARD_VIEW_STATUS[card]
    if (!viewStatus) return
    this.setData({ viewStatus }, () => this.applyFilters())
  },

  resetFilters() {
    this.setData(
      {
        search: '',
        category: '',
        viewStatus: 'active_all',
        sort: DEFAULT_INVENTORY_SORT,
        hasActiveConditions: false,
      },
      () => this.applyFilters(),
    )
  },

  findItem(itemId: string) {
    return this.data.items.find((item) => item._id === itemId)
  },

  openItem(event: WechatMiniprogram.CustomEvent<{ itemId: string }>) {
    wx.navigateTo({ url: `/pages/item-detail/index?id=${event.detail.itemId}` })
  },

  editItem(event: WechatMiniprogram.CustomEvent<{ itemId: string }>) {
    wx.navigateTo({ url: `/pages/item-form/index?id=${event.detail.itemId}` })
  },

  // ±1 直接落库；数量事件只带 delta，0 视为无效忽略（数字点击走 quantityset 内联编辑）。
  openQuantity(event: WechatMiniprogram.CustomEvent<{ itemId: string; delta?: number }>) {
    const item = this.findItem(event.detail.itemId)
    if (!item) return
    const delta = event.detail.delta === 1 || event.detail.delta === -1 ? event.detail.delta : 0
    if (!delta) return
    const quantity = stepQuantity(item.quantity, delta)
    if (quantity === item.quantity) return
    void this.applyQuantity(item, quantity)
  },

  setQuantity(event: WechatMiniprogram.CustomEvent<{ itemId: string; quantity: number }>) {
    const item = this.findItem(event.detail.itemId)
    if (!item) return
    const quantity = event.detail.quantity
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_ITEM_QUANTITY) return
    void this.applyQuantity(item, quantity)
  },

  async applyQuantity(item: InventoryCardItem, quantity: number) {
    if (this.data.actionLoading) return
    this.setData({ actionLoading: true })
    try {
      const result = await updateQuantity(item, quantity)
      this.setData({ actionLoading: false })
      // 成功不弹 toast：数字本身会跳一下（inventory-row 的 quantityFlash），
      // 数量就在原地变化，再盖一层遮罩式提示反而碍事。
      this.patchItem(item._id, { quantity, version: result.version })
      // 数量变化会影响「状态良好」计数（不改变 active 总数），保险起见置脏。
      this.invalidateOverview()
    } catch (error) {
      this.handleActionError(error)
    }
  },

  patchItem(itemId: string, patch: Partial<InventoryCardItem>) {
    const index = this.data.items.findIndex((item) => item._id === itemId)
    if (index < 0) return
    const merged = toInventoryCardItem({ ...this.data.items[index], ...patch } as InventoryCardItem)
    this.setData({ [`items[${index}]`]: merged })
  },

  openMore(event: WechatMiniprogram.CustomEvent<{ itemId: string }>) {
    const item = this.findItem(event.detail.itemId)
    if (!item) return
    this.setData({ moreSheet: { visible: true, itemId: item._id, name: item.name } })
    this.setTabBarHidden(true)
  },

  closeMore() {
    this.setData({ moreSheet: emptyMoreSheet() })
    this.setTabBarHidden(false)
  },

  async handleMoreAction(event: WechatMiniprogram.CustomEvent) {
    const action = event.currentTarget.dataset.action as MoreAction
    const item = this.findItem(this.data.moreSheet.itemId)
    if (!item) {
      this.closeMore()
      return
    }
    if (action === 'complete') await this.completeItemAction(item)
    else if (action === 'delete') await this.deleteItemAction(item)
  },

  async completeItemAction(item: InventoryCardItem) {
    if (this.data.actionLoading) return
    const modal = await wx.showModal({
      title: '标记为已用完？',
      content: '物品会从当前库存移入已用完记录。',
      confirmText: '已用完',
      confirmColor: '#245B49',
    })
    if (!modal.confirm) return
    this.setData({ actionLoading: true })
    try {
      await completeItem(item._id, item.version)
      track('item_used_up')
      this.setData({ actionLoading: false })
      this.closeMore()
      wx.showToast({ title: '已标记为用完', icon: 'success' })
      this.invalidateOverview()
      void this.refresh(true, false)
    } catch (error) {
      this.handleActionError(error)
    }
  },

  async deleteItemAction(item: InventoryCardItem) {
    if (this.data.actionLoading) return
    const modal = await wx.showModal({
      title: '删除这件物品？',
      content: '删除后会移入回收站，30 天内可以重新编辑并入库。',
      confirmText: '删除',
      confirmColor: '#A33F32',
    })
    if (!modal.confirm) return
    this.setData({ actionLoading: true })
    try {
      await deleteItem(item._id, item.version)
      this.setData({ actionLoading: false })
      this.closeMore()
      wx.showToast({ title: '已删除', icon: 'success' })
      this.invalidateOverview()
      void this.refresh(true, false)
    } catch (error) {
      this.handleActionError(error)
    }
  },

  handleActionError(error: unknown) {
    this.setData({ actionLoading: false })
    const message = getErrorMessage(error)
    wx.showToast({ title: message, icon: 'none', duration: 2500 })
    if (error instanceof CloudServiceError && error.code === 'CONFLICT') {
      void this.refresh(true, false)
    }
  },

  openBatchOperations() {
    if (!this.data.items.length) return
    const app = getApp<IAppOption>()
    app.globalData.pendingBatchIntent = {
      source: 'home',
      search: this.data.search,
      category: this.data.category,
      viewStatus: this.data.viewStatus,
    }
    wx.navigateTo({ url: '/pages/batch-operation/index?source=home' })
  },

  addItem() {
    wx.navigateTo({ url: '/pages/quick-entry/index' })
  },

  handleEmptyAction() {
    if (this.data.hasActiveConditions) this.resetFilters()
    else this.addItem()
  },

  retry() {
    void this.refresh(true, false)
  },

  retryLoadMore() {
    void this.refresh(false, false)
  },

  noop() {},
})
