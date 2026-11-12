# 专题：小红书关键词搜索与详情

> 状态：🟡 列表已采，详情覆盖率仅 2.4%
> 站点分册：[sites/xiaohongshu.com.md](../../sites/xiaohongshu.com.md) ｜ 攻略：[playbooks/xiaohongshu.com.json](../../playbooks/xiaohongshu.com.json)

## 一、目标

按关键词搜小红书笔记，筛选后抓详情（正文 + 评论），做消费/职场话题的内容分析（如携程金融线专项）。

## 二、已完成

| 批次 | 规模 | 工作区目录 |
|---|---|---|
| 12 个关键词搜索结果 | 1,995 条笔记 | `output/xhs/` |
| 详情 | 48 条（覆盖率 2.4%） | `output/xhs/details/` |
| 携程金融线专项 | 61 篇（32 篇有正文 / 146 条评论） | `output/xhs/_finance_*.json` |

标题层分析与口径限制见 **[FINDINGS.md](FINDINGS.md)**（2026-11-12）。

## 三、关键结论（勿重复踩）

- **headless 直接进验证码页**，必须 `headless: false`
- 搜索 API 高频请求返回 **HTTP 461**；命中立即停，不要重试
- 详情间隔必须 **≥9 秒**（实测 18 篇 @9s 安全；47 篇 @2.5s 直接 461）
- 正文为空时**先怀疑风控**：查 `page.url()` 是否含 `website-login/captcha`、搜索 API 是否 461，再怀疑选择器
- 两阶段策略：列表扫描 → 按标题筛选 → 详情（标题命中「携程/裁员/加班/金融」优先，互动 ≥1000 次之）

## 四、数据位置

```
F:\despseekharness\crawler\output\xhs\           # 搜索结果与详情
F:\despseekharness\crawler\output\xhs\details\   # 逐篇详情
```

## 五、下一步（对应 TODO.md TODO-5）

1. 按分诊规则补抓详情：标题关键词优先，互动数 ≥1000 次之
2. 每批抓完检查 `RiskControlError`，触发即停
3. 目标把详情覆盖率从 2.4% 提到可用水平（先做高价值子集，不求全覆盖）
