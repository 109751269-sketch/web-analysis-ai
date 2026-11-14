# 牛客 nowcoder.com

> 状态：已沉淀（2026-11-09 实测）
> 需登录：**否**（公开 API）
> 连接方式：HTTP API，不需要浏览器

---

## 关键优势

牛客是唯一**完全免登录、无风控**的渠道。优先抓这个，最省成本。

---

## 接口

Base: `https://gw-c.nowcoder.com/api/sparta`

| 用途 | 端点 | 方法 |
|---|---|---|
| 搜公司 | `/pc/search` | **POST** + JSON body `{query, type:'all', page:1}` |
| 评价维度 tag | `/experience/company/evaluation/tag?id=<companyId>` | GET |
| 评价列表 | `/experience/company/evaluation/list?companyId=<id>&pageNo=<n>[&tagId=<tid>]` | GET |
| 评论 | `/comment/list-by-page?entityId=<cid>&entityType=250&order=2&pageNo=<n>` | GET |

**必须带的 header**：
```js
{
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...',
  'Referer': 'https://www.nowcoder.com/',
  'x-requested-with': 'XMLHttpRequest',     // 少了会被拒
  'Content-Type': 'application/json',       // 仅 POST
  'accept-language': 'zh-CN',
}
```

---

## 已知坑

### 坑 1：搜索只吃 POST

- **现象**：GET `/company/search` 返回 200 但报文说 method not supported，`code` 是 undefined。
- **修法**：用 `/pc/search` + POST + JSON body。公司结果在 `data.records` 里，筛 `rc_type === 205`。

### 坑 2：中文参数不能经 shell 传

- **现象**：UTF-8 经 shell 传递会坏，搜「携程」变乱码。
- **修法**：用 Node `fetch` + `JSON.stringify({query: '携程'})`，不要拼 shell 命令。

### 坑 3：站点自报数虚高（2026-11-10 实测）

- **现象**：携程 tag 页自报 703 条评价，实际 `total` 只有 **113**，去重后 91 条。
- **根因**：自报数含各维度 tag 的重复计数（163+168+133+19+62+158 ≈ 703，但实际去重后仅 113）。
- **修法**：以 `data.total` 为准，不以 tag 的 `count` 为准。报告里两个数都写。
- **验证方法**：`pageNo` 超出 `totalPage` 返回空数组，说明到顶。

### 坑 4：公司实体的判定

搜「携程金融」「携程小贷」「拿去花」等，`rc_type === 205` 的公司结果数为 **0**，只有「携程」（`companyId=153`）。

**结论**：牛客没有「携程金融」独立公司实体，金融线内容只能靠在「携程」的评价正文里搜关键词，命中率极低（91 条里 0 条）。

### 坑 5：正文有两条路径（按 contentType 分流），contentId 是字符串

**⚠️ 2026-11-14 补全**：同一份 `nc_<id>_<公司>.json` 里混着两种记录类型，只取一条路径会**漏掉约一半正文**，并制造「污染率 71.5%」这类假信号（实测修正后真实软文率仅 1.2%）。

| `contentType` | 正文路径 | 实测占比（美团 921 条） |
|---|---|---|
| `74` | `momentData.content` | 518 |
| `250` | `contentData.content` | 403 |

```js
// 写任何牛客解析前，先按 contentType 分组抽样，确认字段路径
function textOf(rec) {
  const m = rec.momentData || {}, c = rec.contentData || {}, ie = rec.interviewExp || {};
  return String(m.content || c.content || ie.content || rec.content || rec.title || '')
    .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
rec.contentId                    // 字符串，如 '929473191548899328'
rec.frequencyData?.commentCnt    // 评论数（74 型）
rec.momentData?.commentCount     // 评论数（250 型可能不同）
```

注意 `contentId` 是字符串，用 `===` 比较数字会失败。
清洗脚本见工作区 `crawler/clean_nowcoder_spam.js`（15 家 / 7,001 条，软文 83 条，干净集 `_clean_records.jsonl`）。

---

## 采集脚本

| 脚本 | 用途 |
|---|---|
| `nc_tags_collect.js <companyId> [name]` | 按维度 tag 采全量评价 |
| `nc_batch.js` | 批量多公司 |
| `nc_comments_collect.js` | 补评论 |

或走统一入口 `lib/research.js --sites=nowcoder`（内部调 `lib/sites/nowcoder.js`）。

---

## 已采公司 companyId

| 公司 | id | 条数 |
|---|---|---|
| 携程 | 153 | 91 |
| 阿里巴巴集团 | 134 | — |
| 腾讯 | 138 | — |
| 百度 | 139 | — |
| 网易 | 149 | — |
| 京东 | 151 | — |
| 美团 | 179 | — |
| 华为 | 239 | — |
| 滴滴 | 652 | — |
| 字节跳动 | 665 | — |
| 大疆 | 708 | — |
| 小红书 | 715 | — |
| 拼多多 | 732 | — |
| 快手 | 898 | — |
| 蚂蚁集团 | 931 | — |

---

## 节流参数

**风控等级：无**（公开 API，无验证码、无频率限制、无账号绑定）

| 动作 | 间隔 | 说明 |
|---|---|---|
| 评价分页 | 280ms | 实测 6 页无异常 |
| 评论分页 | 260ms | — |
| 帖间 | 200ms | — |

**可以快抓**。这是唯一不需要考虑风控的渠道，优先用。
