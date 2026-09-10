interface TabBarDataset {
  index?: string | number
  url?: string
}

Component({
  data: {
    selected: 0,
    hidden: false,
  },

  methods: {
    switchTab(event: WechatMiniprogram.CustomEvent) {
      if (this.data.hidden) return
      const dataset = event.currentTarget.dataset as TabBarDataset
      const index = Number(dataset.index)
      const url = dataset.url
      if (!url || Number.isNaN(index)) return
      if (index === this.data.selected) return
      wx.switchTab({ url })
    },

    handleAdd() {
      if (this.data.hidden) return
      wx.navigateTo({ url: '/pages/quick-entry/index' })
    },
  },
})
