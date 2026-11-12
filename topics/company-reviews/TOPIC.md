# 专题：公司评价与薪资（牛客 + 职友集）

> 状态：🟡 15 家已采，三项统计口径待修
> 站点分册：[sites/nowcoder.com.md](../../sites/nowcoder.com.md)、[sites/jobui.com.md](../../sites/jobui.com.md)

## 一、目标

用免登录渠道（牛客公开 API + 职友集 HTTP）采集大厂员工评价与薪资数据，做「哪家公司更值得去」的横向对比，避免依赖脉脉登录态。

## 二、已完成

| 渠道 | 规模 | 工作区目录 |
|---|---|---|
| 牛客 | 15 家公司 / 7,001 条评价，2019-01 ~ 2026-11 | `output/nowcoder/`（`nc_<id>_<公司>.json`） |
| 职友集 | 15 家公司 ID 已解析 + 2 条补充 | `output/jobui/`（`_ids.json` 17 条） |

已覆盖：腾讯 / 阿里 / 百度 / 网易 / 京东 / 携程 / 美团 / 华为 / 滴滴 / 字节 / 大疆 / 小红书 / 拼多多 / 快手 / 蚂蚁 / 联想。

已产出：`report_bigtech_vs_dji.md`、`rank_v3` 系列报告。

牛客标签与覆盖率分析见 **[FINDINGS.md](FINDINGS.md)**（2026-11-12）；复跑：`node topics/analyze_topics.js`。

## 三、关键结论（勿重复踩）

- **牛客优先**：公开 HTTP API 免登录无风控，比脉脉省事
- 职友集搜索接口连调 2 次即验证码，间隔必须 ≥25s，命中冷却 60s
- 职友集**搜索结果按相关度排序，第一条就是主体公司**，不要加过滤规则（加过滤会选错，实测排除正确结果 4 次）
- 公司级平均薪资含骑手/客服岗，**不能对标技术岗**，必须走岗位细分页 `/company/<id>/salary/j/<岗位拼音>/`
- 不能盲目相信站点自报数（牛客自报 703 实际 113）

## 四、数据位置

```
F:\despseekharness\crawler\output\nowcoder\   # 15 家公司评价 + comments/ + details/
F:\despseekharness\crawler\output\jobui\      # _ids.json 公司 ID 缓存（永久复用，勿覆盖）
```

## 五、下一步（对应 TODO.md 未完成项）

1. TODO-1 职友集剩余公司 ID 未解析（≥25s 间隔）
2. TODO-2 牛客「裁员」统计被「优化简历/性能优化」污染，正则需带裁员语境
3. TODO-3 growthScore 薪资部分改用岗位细分数据
4. TODO-6 职友集岗位细分薪资批量采集（`THROTTLE.jobMs = 12000` 已设但脚本未使用）
