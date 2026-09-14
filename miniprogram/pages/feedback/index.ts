import { getErrorMessage } from '../../services/cloud-client'
import { submitFeedback } from '../../services/user-service'

const FEEDBACK_MAX_LENGTH = 500

Page({
  data: {
    content: '',
    characterCount: 0,
    maxLength: FEEDBACK_MAX_LENGTH,
    canSubmit: false,
    submitting: false,
    submitError: '',
  },

  handleInput(event: WechatMiniprogram.Input) {
    const content = event.detail.value
    this.setData({
      content,
      characterCount: Array.from(content).length,
      canSubmit: Boolean(content.trim()),
      submitError: '',
    })
  },

  async submit() {
    if (!this.data.canSubmit || this.data.submitting) return
    this.setData({ submitting: true, submitError: '' })
    try {
      await submitFeedback({ content: this.data.content })
      this.setData({
        content: '',
        characterCount: 0,
        canSubmit: false,
        submitting: false,
      })
      await wx.showModal({
        title: '感谢你的反馈',
        content: '你的建议已经提交，我们会认真查看。',
        showCancel: false,
        confirmText: '知道了',
      })
      wx.navigateBack()
    } catch (error) {
      this.setData({ submitting: false, submitError: getErrorMessage(error) })
    }
  },

  noop() {},
})
