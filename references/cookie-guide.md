# Cookie 指南：按网站分文件存放（skill 目录内）

## 为什么按网站分文件

Cookie 由浏览器按 **domain（域名）** 隔离：`domain=.x.com` 的 cookie 只会随 x.com 的请求发送，对其他站点（maimai、zhipin）完全无效。所以**每个站点一个 cookie 文件**，命名 `<站点host>.json`，不会串号。

## 标准位置（skill 目录内，随 skill 自包含）

```
C:\Users\sun\.agents\skills\web-analysis-ai\
├── SKILL.md
├── cookies\               ← 凭证（分享 skill 前先删除本目录）
│   ├── x.com.json
│   └── maimai.cn.json
└── references\
    └── cookie-guide.md    ← 本文档（任务模板见 SKILL.md Phase 2）
```

- 任务文件放**工作区** `F:\despseekharness\crawler\tasks\`，`"authFile"` 用**绝对路径**指向 skill cookies：`C:/Users/sun/.agents/skills/web-analysis-ai/cookies/<站点host>.json`（任务与 cookies 跨目录/跨盘，必须绝对路径）
- 结构（引擎/工作区分离）：
  ```
  skill 基目录\
  ├── project\                   ← 引擎（执行代码+依赖+playbooks）
  ├── cookies\x.com.json         ← 凭证（分享 skill 前先删除本目录）
  └── references\...
  F:\despseekharness\crawler\    ← 工作区（任务文件、output 产物、临时文件）
  ├── tasks\<任务>.json          ← authFile: "C:/.../cookies/x.com.json"（模板见 SKILL.md Phase 2）
  └── output\<任务名>\...        ← 每次执行生成的结果
  ```

## 填充步骤（Cookie-Editor 格式）

1. 浏览器装 [Cookie-Editor](https://chrome.google.com/webstore/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm)；
2. 登录目标站（如 x.com）；
3. 扩展图标 → `Export` → `Export as JSON`；
4. 把导出的 JSON **数组整体替换** `cookies/<站点host>.json` 里的 `[]`；
5. 脚本（lib/auth.js）自动规范化：`No_restriction→Lax`、`session→-1`、`path 默认 /`、`SameSite=None 自动补 secure`，无需手工处理。

## 任务引用示例（X）

```json
{
  "url": "https://x.com/home",
  "authFile": "C:/Users/sun/.agents/skills/web-analysis-ai/cookies/x.com.json",
  "tabs": [
    { "name": "正在关注", "dblclick": true, "waitMs": 2500 },
    { "name": "最近", "waitMs": 4000 }
  ],
  "extract": { "incremental": true, "containerSelectors": ["article", "[data-testid=\"tweet\"]"], "limit": 500 }
}
```

## 过期处理

- 会话过期（几小时~几天）：重新 Export 覆盖对应文件，**任务配置不用改**，`authFile` 仍指向同一路径。
- 任务失败先怀疑 Cookie：看抓取日志 `✓ 会话有效` / `⚠ 域名不匹配` / `未检测到登录特征`。

## 安全提醒

- 本目录含登录凭证：**分享/上传 skill 前务必删除 `cookies/`**。
- 项目内 `tasks/` 任务文件包含 authFile 路径引用，外发时同样注意脱敏。
