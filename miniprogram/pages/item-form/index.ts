interface SavedDetail {
  restoring: boolean
  itemId: string
  source: string
  name: string
  expiryDate: string
}

/** 完整录入表单页；表单本体在 components/item-form-sheet，编辑、重新入库走同一套实现。 */
Page({
  data: {
    itemId: '',
    restore: false,
  },

  onLoad(options: Record<string, string | undefined>) {
    const itemId = options.id || ''
    const restore = options.restore === '1'
    this.setData({ itemId, restore })
    wx.setNavigationBarTitle({ title: restore ? '重新编辑' : itemId ? '编辑物品' : '新增物品' })
  },

  handleSaved(event: WechatMiniprogram.CustomEvent) {
    const detail = event.detail as unknown as SavedDetail
    wx.showToast({
      title: detail.restoring ? '已重新入库' : detail.itemId ? '修改成功' : '已加入库存',
      icon: 'success',
    })
    wx.navigateBack()
  },
})
