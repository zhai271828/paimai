# 《拍卖师法则 Online》开发进度记录

原始目标：在 `E:\code\拍卖\code` 中实现《拍卖师法则》的网页实时多人联机版。

说明：这个文件以后作为项目交接和实时状态记录使用。每完成一个阶段性任务，都把最新状态追加到文件底部，避免进度丢失。

日志时间要求：从 2026-06-12 16:47 开始，所有新增实时更新都必须写到“年-月-日 小时:分钟”，例如 `2026-06-12 16:47`。

## 当前总判断

- 当前项目已经从早期 MVP 升级成“可试玩的多人联机原型”。
- 现在不能认为 v1.0 已完成。
- 现在不能认为所有卡牌、事件、属性都已经完整生效。
- 现在不能达到上架发售标准。
- 可以继续作为 v1.0 开发基线推进。

## 已完成内容

- 建立了 TypeScript monorepo 工程结构，包含：
  - `apps/web`：React + Vite 前端。
  - `apps/server`：Fastify + Socket.IO 服务端。
  - `packages/shared`：共享类型、数据、Socket 协议。
  - `packages/engine`：纯规则引擎 reducer。
- 已实现基础多人房间流程：
  - 创建房间。
  - 4 位数字房间码。
  - 加入房间。
  - 准备/取消准备。
  - 开始游戏。
  - 私有玩家视图推送。
  - 断线后基础 resume。
- 已实现基础牌桌流程：
  - 3-5 人。
  - 10 天完整局框架。
  - 每日晨间骰子收入。
  - 黑市阶段。
  - 预展阶段。
  - 锦囊/事件窗口。
  - 拍卖阶段。
  - 结算阶段。
  - 事件窗口。
  - 自由交易阶段。
  - 终局结算阶段。
- 已接入完整内容数据管线：
  - 240 件藏品。
  - 31 个属性。
  - 43 张锦囊。
  - 30 张事件卡，其中包括 28 张普通事件和 2 张自然事件。
  - 52 张秘密委托。
  - 9 个角色。
- 已从 DOCX 内容生成 `content/*.json` 和共享代码中的 generated content。
- 已加入内容校验脚本 `npm run validate:content`。
- 已扩展共享类型：
  - 4 种拍卖模式。
  - 角色。
  - 双委托。
  - 反制窗口。
  - 交易报价。
  - ActionLog / RoomSnapshot 类型。
  - ContentVersion。
  - 私有 PlayerView。
- 已实现 4 种拍卖模式的基本规则：
  - 英式拍卖。
  - 荷兰式拍卖。
  - 暗标拍卖。
  - 打包拍卖。
- 已实现暗标平局追加暗标。
- 已实现荷兰式价格随时间下降，并支持喊停。
- 已实现打包拍卖一次获得两件藏品。
- 已实现交易报价和接受/拒绝。
- 已实现贷款与还贷。
- 已实现角色和双委托展示。
- 已实现部分隐藏信息保护：
  - 非主持人看不到预展完整传闻区间。
  - 他人看不到藏品真实价值和属性。
  - 自己获得的藏品会公开给自己。
  - 终局阶段公开最终信息。
- 已实现反制窗口基础机制：
  - 干扰类锦囊会先进入待反制状态。
  - eligible 玩家可以反制或放弃。
  - 反制成功会真正取消原效果。
  - 所有人放弃后原效果才结算。
- 已实现部分 custom 锦囊真实效果：
  - `B04 搅局流拍`：当前拍品流拍并弃置，主持人不可自吞。
  - `B06 最后一口`：英式竞拍中立刻加价 20。
  - `C01 典当券`：下一次卖银行按 100% 回收。
  - `D01 封口`：目标玩家本日不能使用锦囊。
  - `D04 断其粮草`：目标弃 1 张锦囊。
  - `D05 画地为牢`：目标本日不能卖银行或玩家交易。
  - `D06 破财消灾`：目标失去最多 10 银元。
  - `D07 逐客令`：目标本日不能对指定藏品出价。
- 前端已补上：
  - 4 种拍卖模式选择。
  - 打包拍卖内层模式选择。
  - 荷兰式喊停按钮。
  - 暗标提交。
  - 反制提示。
  - 自由交易面板。
  - 交易邀请接受/拒绝。
  - 还贷按钮。
  - 角色面板。
  - 双委托面板。
  - 手牌和事件牌展示。
  - `window.render_game_to_text` 状态输出。

## 已通过验证

最近一次验证结果：

- `npm run validate:content`：通过。
- `npm run build`：通过。
- `npm run test`：通过，12 条引擎测试全部通过。
- `npm run test:socket`：通过。
- `npm run test:e2e`：通过。
- 使用 `develop-web-game` 的 Playwright 客户端跑过页面截图采样。
- 已人工查看截图：
  - `output/web-game/shot-0.png`
  - `output/e2e/mobile-entry.png`
  - `output/e2e/desktop-host.png`
  - `output/e2e/desktop-winner.png`
- 截图中没有看到空白页面、明显遮挡或严重错位。

## 仍然存在的问题

- 内容校验虽然通过，但仍有 custom resolver 警告。
- 下面这些锦囊还没有完整精确实现：
  - `B01 保守出价`
  - `B02 坐地分赃`
  - `B05 暗标加封`
  - `B08 雁过拔毛`
  - `C03 回购凭证`
  - `D02 巧取豪夺`
  - `D03 搜身`
  - `R01 封存`
  - `R02 无懈可击`
  - `R03 来日方长`
  - `R04 水银`
  - `R05 祸水东引`
- 事件卡里也有不少 custom/log-only 效果，还没有逐张精确实现。
- 属性里也有不少 custom/log-only 效果，还没有逐个接入规则引擎。
- 52 张委托目前是启发式判定，不是逐张精确规则。
- 角色技能已经展示，但大部分技能还没有完整主动/被动触发逻辑。
- 房间持久化还没完成：
  - 目前主要是内存房间状态。
  - 还没有真正落地 SQLite/JSONL 仓储。
  - 还没有完成 snapshot + action log 恢复。
- 断线重连只是基础可用，还没有覆盖所有长局/并发/崩溃恢复情况。
- 反制链还只是基础机制，还没有完整支持复杂反制：
  - 延迟结算。
  - 转移目标。
  - 对单人取消。
  - 多反制优先级。
- 并发边界还需要补充：
  - 荷兰式多人同时喊停。
  - 暗标同时提交。
  - 交易报价期间资产变化。
  - 目标藏品或玩家状态变化。
  - 主持人断线。
  - 牌库耗尽。
  - 黑市购买上限和事件影响叠加。
- 前端还不是商品级：
  - 缺少完整规则说明。
  - 缺少新手引导。
  - 错误提示还比较工程化。
  - 移动端完整牌桌体验没有系统打磨。
  - 终局翻牌和计分展示还不够发售级。

## 后续优先级

1. 补齐所有锦囊、事件、属性的真实效果。
2. 把 52 张委托改成逐张精确判定。
3. 完成角色技能的触发规则和测试。
4. 完成持久化仓储、快照、action log 恢复。
5. 增加隐藏信息专项测试，防止客户端泄露真值、属性、他人手牌、他人委托、暗标金额。
6. 增加完整 10 天局自动化测试。
7. 增加浏览器 E2E 覆盖：
   - 荷兰式。
   - 打包拍卖。
   - 交易。
   - 反制。
   - 终局翻牌。
   - 移动端关键流程。
8. 做 UI/UX 产品化打磨。

## 实时更新日志

### 2026-06-12

- 2026-06-12 16:47：收到新的开发要求：后续每次更新日志必须加入小时和分钟；接下来继续完成 52 张委托逐张精确判定、9 个角色完整技能、31 个属性逐项规则。
- 2026-06-12 16:52：已开始 52 张委托逐张精确判定开发；新增多项整局统计字段，并将委托判定从关键词启发式改为按 W01-W52 明确 ID 判定。当前 `npm run test` 规则单测通过，正在修复编译和补充专项测试。
- 2026-06-12 16:56：52 张委托逐张精确判定已阶段性完成；新增 `GameStats` 整局统计，覆盖竞拍、贷款、倒手、黑市、信息、主持、自吞等条件；新增 W01-W52 全量委托成功路径测试，`npm run test` 当前 20 条全部通过。
- 2026-06-12 17:00：开始 9 个角色完整技能开发；已新增 `role:skill` 协议、服务端 handler、引擎 `USE_ROLE_SKILL` 动作，并接入一批主动技能和被动技能触发点（探查、加属性、镇馆之宝、窃听、黑料、包装、暗箱操作、黑市商人被动、富豪开局现金、赌徒低现金收入、投机商交易/捡漏、拍卖师佣金等）。当前引擎编译通过，仍在补终局被动、前端按钮和测试。
- 2026-06-12 17:03：接续开发前先确认当前基线：`npm run build --workspace @auctioneer/shared`、`npm run build --workspace @auctioneer/engine`、`npm run test` 均通过，规则单测当前 20 条全部通过；可以继续补角色和属性，不是在坏基线上叠代码。
- 2026-06-12 17:19：角色/属性规则层继续推进：新增弃牌堆、每日贷款计数、角色技能来源、暗标可见信息等状态字段；接入角色窃听可见性、千术暗标修改、黑料作废委托、暗箱整局次数、嗅觉额外锦囊、每日技能重置；接入多项属性逐项规则（热门交易补贴、易损保护费、钱能通神、锦囊妙计、贷款/银行/黑市属性、终局价值倍率等）。`shared` 和 `engine` 编译已通过，接下来补测试和前端按钮。
- 2026-06-12 17:29：前端已补角色技能按钮和赌徒暗标可见显示；修正易损保护费触发到黑市结束、投机商奇货每日限 1 次、银行回收按出售藏品的属性判断。验证结果：`shared` 编译通过、`engine` 编译通过、`web` 编译通过、`npm run test` 20 条通过。下一步补角色/属性专项测试。
- 2026-06-12 17:37：新增角色/属性专项测试并通过：窃听/黑料隐藏信息视图、赌徒千术暗标可见与修改、银行/贷款/交易/黑市属性规则、终局属性精确计值。当前 `npm run test` 为 24 条全部通过，`npm run build` 完整通过。
- 2026-06-12 17:44：继续核对属性和角色规则精度：修正“孤注一掷”为晨间收入重掷取高而非直接加钱，修正“盲盒之王”为影响你所有未被探查藏品，修正“连锁诅咒”为未完成委托时影响所有藏品总价值，修正“锦囊妙计”只从弃牌堆取锦囊。验证结果：`npm run test` 25 条全部通过，`npm run build` 完整通过；`validate:content`、`test:socket`、`test:e2e` 均通过；已用 Playwright 客户端采样并人工查看入口页与牌桌截图，无空白页或明显遮挡。
- 2026-06-12 17:46：补充“千术只能改一次”的边界测试，并再次验证：`npm run test` 25 条全部通过，`npm run build` 完整通过。当前阶段完成度估计更新为：可试玩联机原型约 78%，v1.0 工程规格约 64%；委托约 95%，角色约 85%，属性约 80%。

- 已将英文 `progress.md` 改写成中文版本。
- 明确记录了当前项目不是 v1.0 完成版，也不是可上架版本。
- 明确记录了已完成内容、验证结果、剩余问题和后续开发优先级。
- 本轮继续开发目标：优先补齐剩余 custom 锦囊的真实规则效果，并用编译、单测、内容校验和浏览器验证确认没有明显回归。
- 已完成第一轮规则层核对：
  - `npm run build --workspace @auctioneer/shared`：通过。
  - `npm run build --workspace @auctioneer/engine`：通过。
  - `npm run test`：通过，当前规则单测为 17 条，全部通过。
- 已完成完整自动化验证：
  - `npm run validate:content`：通过，内容数量为 240 藏品、31 属性、43 锦囊、30 事件、52 委托、9 角色，且无 warnings。
  - `npm run build`：通过。
  - `npm run test:socket`：通过。
  - `npm run test:e2e`：通过。
- 继续推进下一开发块：开始实现事件卡真实效果，已在共享类型和规则引擎中加入事件状态字段与每日开始/过期清理钩子；这部分仍在开发中，尚未完成最终验证。
- 事件卡开发块阶段性完成：
  - 已接入一批事件的真实规则钩子：黑市折扣/限购/额外上限/免费锦囊、晨间收入加成或翻倍、银行回收率变化、贷款限制与新贷款还款额、竞拍税、预展信息公开、类别价值涨跌、文化禁令、神秘收购、假货补偿、收藏展邀约等。
  - 已补充事件规则单测，`npm run test` 当前为 19 条规则测试全部通过。
- 已完成本轮完整验证：
  - `npm run validate:content`：通过，内容校验无错误、无警告。
  - `npm run build`：通过。
  - `npm run test`：通过，19 条规则测试全部通过。
  - `npm run test:socket`：通过。
  - `npm run test:e2e`：通过。
  - 已使用 `develop-web-game` 的 Playwright 客户端采样 `http://localhost:5173`，输出截图在 `output/web-game/shot-1.png`。
  - 已人工查看入口页截图和 `output/e2e/desktop-winner.png`，没有发现空白页、明显遮挡或严重错位。
- 当前完成度估计：
  - 可试玩联机原型：约 78%。
  - 按 v1.0 工程规格完整落地：约 64%。
  - 内容数据迁移：100%。
  - 52 张委托逐张判定：约 95%，已有 W01-W52 全量成功路径测试，仍需失败路径和边界组合测试。
  - 9 个角色技能：约 85%，主动按钮和主要被动已接入，仍需更多阶段限制、次数边界、UI 目标选择和组合测试。
  - 31 个属性逐项规则：约 80%，主要经济、终局价值、黑市、贷款、交易、探查影响已接入，仍需每个属性的失败路径与多属性叠加矩阵。
  - 锦囊真实效果：约 90% 以上，仍需更多反制链/目标选择/E2E 覆盖。
  - 事件真实效果：约 65%，本轮补了主流程硬规则，但仍有少数“玩家选择、随机类别、赝品概率调整、保护费选择”等需要更完整 UI 和测试。
- 仍然不能上架发售：
  - 规则层已明显前进，但还缺完整 10 天自动长局、隐藏信息专项 fuzz、崩溃恢复、断线重连压力测试。
  - 角色和属性已接入主要规则，但还没有做到每张/每项所有正反边界都覆盖。
  - 持久化仓储、快照 + action log 恢复仍未完成。
  - 前端仍是可玩工程界面，不是正式发售级 UI/UX；移动端、引导、错误提示、终局展示还需要产品化打磨。

## 最新状态（后续继续往这里追加）

- 2026-06-12 17:46：本轮继续开发已完成并验证通过。已推进 52 张委托逐张判定、9 个角色主要技能、31 个属性主要规则；当前 `npm run test` 为 25 条全部通过，`npm run build` 完整通过，`validate:content`、`test:socket`、`test:e2e` 通过，Playwright 截图已人工查看。当前估计：可试玩联机原型约 78%，v1.0 工程规格约 64%；仍不能上架发售，下一步应做完整 10 天长局、隐藏信息 fuzz、持久化恢复和更多角色/属性边界矩阵。
- 2026-06-12 18:01：收到新任务：完成完整 10 天长局自动测试、隐藏信息 fuzz、断线/恢复/持久化，以及角色和属性失败路径与组合边界矩阵。开始按四条线推进：长局模拟、隐藏信息专项、仓储/action log 恢复、角色/属性边界矩阵。
- 2026-06-12 18:06：已把服务端房间仓储接入主流程：创建/加入房间会保存快照和会话，所有成功动作会追加 action log 并保存最新快照，`room:resume` 在内存会话丢失时会尝试从仓储恢复房间与会话。下一步补断线/重启恢复自动测试。
- 2026-06-12 18:07：断线/恢复/持久化第一版自动测试已完成：新增恢复脚本模拟旧服务器写入仓储、新服务器重启后同 token `room:resume`，验证恢复后仍在拍卖阶段、自己的暗标保留、非赌徒视图不泄露其他暗标和藏品隐藏信息；`npx tsx apps/server/test/recovery.test.ts` 已通过，并已把恢复脚本加入 `npm run test:socket`。
- 2026-06-12 18:14：已新增 10 天长局、隐藏信息 fuzz、角色失败路径、属性组合边界测试草案；第一轮 `npm run test:unit` 出现 4 个校准点：长局驱动未处理暗标平局、隐藏信息测试误期待已消耗反制牌仍在手里、拍卖师暗箱操作在暗标模式下未按文档拒绝、银行价格预期未计入 `prop25`。接下来修测试驱动并修暗箱操作规则边界。
- 2026-06-12 18:20：完整 10 天长局自动测试、隐藏信息 fuzz、角色失败路径矩阵、属性组合边界矩阵已落地到引擎单测；同时修复了私密可见性 `activeEffects` 对无关玩家广播的问题。当前 `npm run test:unit` 通过，规则单测从 25 条增加到 29 条。下一步跑完整验证链。
- 2026-06-12 18:23：本轮完整验证通过：`npm run validate:content` 通过（240 藏品、31 属性、43 锦囊、30 事件、52 委托、9 角色，0 errors/0 warnings），`npm run test` 通过（29 条规则测试），`npm run build` 通过，`npm run test:socket` 通过（包含 socket-flow 和 recovery），`npm run test:e2e` 通过；已使用 `develop-web-game` Playwright 客户端采样 `http://localhost:5173`，并人工查看 `output/web-game/shot-1.png`、`output/e2e/desktop-winner.png`、`output/e2e/desktop-host.png`、`output/e2e/mobile-entry.png`，未发现空白页、明显遮挡或严重错位。当前估计：可试玩联机原型约 82%，v1.0 工程规格约 70%；仍不能上架发售，主要剩余为正式持久化落盘、恢复压力/并发、全部委托失败路径、每项属性更细矩阵、UI/UX 产品化与安全部署。
- 2026-06-12 18:27：补齐轻量 JSONL 落盘仓储 `JsonFileRoomRepository`，并把恢复测试扩展为“同目录新仓储实例冷启动读取 session/snapshot 后继续 `room:resume`”。最终验证重新通过：`npm run validate:content`、`npm run build`、`npm run test`、`npm run test:socket`（含 `file-recovery ok`）、`npm run test:e2e` 全部通过；Playwright 采样与截图复查完成。当前估计更新：可试玩联机原型约 84%，v1.0 工程规格约 73%；仍不能上架发售，下一步应做恢复压力/并发、真实生产存储策略、全委托失败路径和 UI/UX 产品化。
- 2026-06-12 19:17：收到新执行计划：按“高风险优先”继续补逐项失败路径、复杂组合矩阵和前端通用目标选择弹窗。已重新读取 `develop-web-game` skill、`App.tsx`、`engine.test.ts` 和 E2E 脚本；确认当前前端卡牌/角色技能仍主要依赖默认目标，规则测试将先补高风险矩阵，再改前端目标选择体验。

- 2026-06-12 19:21：继续接手高风险规则矩阵与前端目标选择补强；先核对现有测试、引擎和前端结构，避免重复改动。

- 2026-06-12 19:24：已新增第一批高风险规则矩阵测试：52 张委托失败 fixture、角色边界、属性组合、锦囊目标/阻断/模式失败路径；下一步运行单测并按失败点做最小修复。

- 2026-06-12 19:26：单测暴露两个点：E04 黑市查封会被角色/属性加购突破、B06 现金不足 fixture 未压低现金。已修黑市上限计算并校准测试，准备重跑规则单测。

- 2026-06-12 19:26：已修正新增测试夹具：黑市上限矩阵改用锦囊购买以避开事件手牌上限，D07 阻断测试改为先正常创建拍卖再进入 cardWindow。

- 2026-06-12 19:27：修正属性组合矩阵中的 clone 旧引用问题：prop10 弃牌堆和 prop18 主持佣金测试改为按藏品 id 从最新 state 读取。

- 2026-06-12 19:28：修正 prop18 + role09 佣金测试旧引用问题：角色设置改为最新 state 内的 p3，验证主持人佣金应为 35%。

- 2026-06-12 19:28：规则矩阵第一阶段通过：新增 52 委托失败路径、角色边界、属性组合和锦囊失败/阻断矩阵后，
pm run test:unit 33 条全部通过；接下来实现前端通用目标选择弹窗。

- 2026-06-12 19:32：前端目标选择弹窗主体已接入：卡牌/角色主动技能不再自动选第一个目标，改为按动作类型选择玩家、藏品、委托，并支持 role06_skill03 只查看/公开作废。正在跑 web build 检查类型问题。

- 2026-06-12 19:34：已为卡牌/角色按钮增加 data-target-mode，E2E 脚本新增目标弹窗截图与选择流程；下一步运行 build/e2e 验证真实浏览器交互。

- 2026-06-12 19:37：E2E 首轮通过但随机牌局未生成卡牌目标弹窗截图；已增强脚本，要求 cardWindow 必须打开卡牌目标弹窗并截图，同时自动放弃可能出现的反制窗口。

- 2026-06-12 19:37：前端目标选择 E2E 已通过并人工查看截图：卡牌目标弹窗、角色目标弹窗、桌面牌桌和移动入口均正常显示；进入完整验证链。

- 2026-06-12 19:38：完整验证链已通过：validate:content、build、test（33 条）、test:socket、test:e2e 均成功；正在运行 develop-web-game Playwright 客户端采样并复查截图。

- 2026-06-12 19:39：本轮高风险补强完成：新增 52 张委托失败矩阵、角色边界矩阵、属性复杂组合矩阵、锦囊目标/失败/阻断矩阵；修复 E04 黑市查封会被角色/属性加购突破的问题；前端新增通用目标选择弹窗，卡牌与主动角色技能不再自动默认第一个目标，并支持黑料只查看/公开作废。完整验证通过：validate:content、build、test、test:socket、test:e2e、develop-web-game Playwright 采样；已人工查看 target-modal-card、target-modal-role、desktop-host、desktop-winner、mobile-entry、web-game 采样截图。当前估计：可试玩联机原型约 87%，v1.0 工程规格约 78%；仍不是发售版，后续重点是更大规模并发/恢复压力、全量 UI 产品化、部署安全和长期平衡测试。

- 2026-06-12 19:44：开始更大规模并发/恢复压力测试。计划新增无界面 Socket 压测脚本，重点统计多人联机 ack 延迟、p95/p99、错误数、断线 resume 和冷启动恢复一致性。

- 2026-06-12 19:49：已接入 `npm run test:stress` 压测入口，准备执行 20/50/100 房间多人并发、25 房间荷兰式并发喊停、30 房间冷启动恢复测试；本轮报告会重点记录 ack 平均值、p95、p99、最大延迟、错误数和恢复一致性。

- 2026-06-12 19:51：第一次标准压测未完成：在高并发创建/准备房间阶段出现 `player:ready ack timeout`。这说明当前脚本的 8 秒 ack 超时在 400 socket 尖峰下过于激进，也暴露出本机单进程 Socket.IO 广播/ack 背压需要专项观察；下一步把压测脚本改为可配置超时，并保证失败时也落盘统计报告。

- 2026-06-12 19:55：已增强压测脚本：新增 `STRESS_SCALE=quick|standard|soak`、ack/connect/state 超时配置，失败场景也会写入 `output/stress/latest.json`，便于区分“规则预期失败”“真实异常”和“本机高并发背压”。准备先跑 quick 校验工具，再跑 standard 生成正式报告。

- 2026-06-12 19:59：`STRESS_SCALE=quick npm run test:stress` 已通过：5 房间/20 人暗标、3 房间荷兰式并发喊停、3 房间/12 人冷启动恢复均成功。quick 下普通动作 p95 多数在 30-140ms，`room:resume` p95 约 1056ms，提示恢复路径包含明显落盘/读取/广播成本；下一步执行 standard 标准压力。

- 2026-06-12 20:03：standard 压测结果：20/50/100 房间普通主流程全部通过，100 房间/400 socket 暗标主流程 ack p95 约 1773ms、p99 约 1881ms、最大约 1914ms；25 房间荷兰式并发喊停通过，50 个失败均为预期规则失败。但 30 房间/120 人冷启动恢复失败，`room:resume` 出现 30 秒 ack timeout。已定位主要瓶颈：JSONL 仓储追加时整文件读写，恢复时反复全文件扫描，导致多人同时重连延迟被放大。

- 2026-06-12 20:05：已修复本轮压测暴露的持久化性能问题：`JsonFileRoomRepository` 改为 `appendFileSync` 追加 JSONL，并为 action/snapshot/session 冷启动读取建立内存缓存；这不改变 socket 协议和规则，只降低落盘与恢复路径的 I/O 放大。下一步先跑恢复测试，再复测标准恢复压力。

- 2026-06-12 20:05：持久化修复后的基础验证通过：`npm run test:socket` 通过（socket-flow、recovery、file-recovery），`npm run build --workspace @auctioneer/server` 通过。已补 `STRESS_SCALE=recovery` 单场景压测入口，准备复测 30 房间/120 人冷启动恢复。

- 2026-06-12 20:06：`STRESS_SCALE=recovery npm run test:stress` 复测通过：30 房间/120 人冷启动恢复共 750 个动作，0 非预期错误，`room:resume` 平均 1388ms、p95 约 2039ms、p99 约 2047ms、最大约 2048ms；恢复后阶段、自己暗标和隐藏信息检查均通过。相比修复前 30 秒超时，恢复路径已明显改善，但 p95 仍偏高，正式上线前还需要数据库/索引和真实网络压测。

- 2026-06-12 20:08：更大规模并发/恢复压力测试最终报告：
  - 本轮新增并保留 `npm run test:stress`，压测结果会写入 `output/stress/latest.json` 和带时间戳的历史 JSON。支持 `STRESS_SCALE=quick|standard|recovery|soak`，默认 `standard`。
  - 本轮暴露并修复了一个关键联机延迟问题：原 `JsonFileRoomRepository` 每次 JSONL 追加都会整文件读写，恢复时每个 session/snapshot 查询都会全文件扫描；在 30 房间/120 人同时冷恢复时导致 `room:resume` 30 秒 ack timeout。已改为追加写入，并为 action/snapshot/session 建立冷启动内存缓存。
  - 修复后完整 `standard` 压测通过，测试环境为本机 127.0.0.1 Socket.IO websocket，不包含公网 RTT、TLS、代理、CDN、浏览器渲染和移动网络波动。
  - `baseline-20rooms-80players`：20 房间/80 socket，380 动作，0 非预期错误；整体 ack p95 418.58ms，p99 458.79ms，最大 475.04ms；内存约 79MB -> 361MB。
  - `load-50rooms-200players`：50 房间/200 socket，950 动作，0 非预期错误；整体 ack p95 982.01ms，p99 1044.30ms，最大 1060.54ms；内存约 361MB -> 646MB。
  - `large-100rooms-400players`：100 房间/400 socket，1900 动作，0 非预期错误；整体 ack p95 1693.36ms，p99 1803.86ms，最大 1834.21ms；内存约 646MB -> 1047MB。最慢普通动作是 `sealedBid:submit`，p95 1807.54ms、p99 1827.28ms、最大 1834.21ms。
  - `conflict-25rooms-dutch-stop`：25 房间/100 socket，475 动作，其中 50 个荷兰式并发喊停失败均为预期规则失败，0 非预期错误；整体 ack p95 266.08ms，p99 296.92ms，最大 305.20ms。说明同一房间 action queue 能保证并发喊停只有一人成功。
  - `recovery-30rooms-120players`：30 房间/120 socket，750 动作，0 非预期错误；整体 ack p95 2004.65ms，p99 2111.41ms，最大 2123.31ms；`room:resume` 平均 1416.46ms，p95 2113.77ms，p99 2122.00ms，最大 2123.31ms。恢复后拍卖阶段、自己的暗标和隐藏信息检查均通过。
  - 回归验证：`npm run validate:content` 通过（240 藏品、31 属性、43 锦囊、30 事件、52 委托、9 角色，0 errors/0 warnings），`npm run build` 通过，`npm run test` 通过（33 条），`npm run test:socket` 通过。
  - 联机延迟判断：当前单机基线说明服务端主流程可以在本机承受 100 房间/400 socket 的短时并发，但 p95 已接近 1.7 秒，暗标提交 p95 约 1.8 秒；冷启动恢复 p95 约 2.1 秒。真实公网环境会额外叠加玩家到服务器 RTT、TLS/反向代理、跨地区路由、移动网络抖动和浏览器渲染，因此不能据此认为已经达到可上架的在线稳定性标准。
  - 当前结论：多人联机压力测试从“未覆盖”推进到“有可复现脚本、有标准数据、有一次性能瓶颈修复”。但仍不是发售级：还需要正式数据库或索引仓储、房间分片/进程横向扩展、消息频率削峰、恢复请求限流、真实云服务器压测、弱网/丢包/高 RTT 测试、长时间 soak 测试和监控告警。
  - 建议下一步：把 JSONL 仓储替换为 SQLite/PostgreSQL 并给 `sessionToken`、`roomId`、`actionIndex` 建索引；增加 `server:metrics` 或压测过程中的 per-room 队列长度/广播耗时统计；用云端 1C/2C/4C 实例分别跑 `STRESS_SCALE=standard` 与 `soak`；补 30-60 分钟长稳测试，观察内存是否持续增长。

- 2026-06-12 20:16：根据当前定位，如果先按小规模好友房/熟人局上线测试，并发压力可以暂时降为中优先级；剩余更关键的问题是：正式启动默认持久化与重连体验、规则和内容的少数复杂边界、前端产品化体验、长局防卡死与托管、部署安全、日志监控、版本管理和发行前 QA。

- 2026-06-12 20:18：后续推进路线建议：
  - 第一阶段“可放心内测”：接入正式启动默认持久化；前端断线/刷新/重连后自动 `room:resume`；恢复失败时提供重新加入/清除会话提示；增加房主转移、掉线标识、超时自动跳过或托管；补 10 天长局防卡死 E2E。
  - 第二阶段“规则可信”：继续补少数复杂组合边界，重点是反制链、交易+属性、事件持续时间、角色技能次数重置、委托失败惩罚、终局计分复现；每次补规则都同步测试和内容校验。
  - 第三阶段“体验产品化”：重做等待/行动提示、玩家状态、目标选择、错误提示、终局翻牌、规则说明和移动端关键流程；目标是新玩家不用读开发文档也能完成一局。
  - 第四阶段“上线工程”：部署配置、环境变量、持久化目录/数据库、日志、健康检查、错误上报、限流、防刷房间、CORS 白名单、备份和恢复演练。
  - 第五阶段“版本与 QA”：内容版本锁定、存档兼容策略、发行候选分支、回归脚本、内测反馈表、已知问题清单、上线前 smoke test 和回滚方案。

- 2026-06-12 20:28：开始落实第一阶段“可放心内测”：已将正式服务端启动默认仓储改为 JSONL 落盘（`AUCTIONEER_DATA_DIR` 可配置，`AUCTIONEER_REPOSITORY=memory` 可切回内存）；前端增加 connect/reconnect 后自动 `room:resume`、恢复失败清除旧会话入口、连接状态提示和玩家离线标识；规则层增加房主离线转移和当前主持离线后的系统主持兜底。当前 `npm run test:unit` 34 条通过，`npm run test:socket` 通过，`npm run build` 通过；正在跑浏览器 E2E 和截图复查。

- 2026-06-12 20:37：第一阶段“可放心内测”基础版完成：
  - 正式启动默认持久化：`apps/server/src/index.ts` 默认使用 `JsonFileRoomRepository`，数据目录为 `AUCTIONEER_DATA_DIR` 或 `data/rooms`；需要临时内存模式时可设 `AUCTIONEER_REPOSITORY=memory`。
  - 重连体验：前端每次 `connect/reconnect` 都会读取本地 session 并自动 `room:resume`；恢复中、断线、恢复失败都有提示；恢复失败可清除旧会话；E2E 新增刷新后恢复同一房间截图 `output/e2e/resume-after-refresh.png`。
  - 掉线与防卡死：玩家列表显示“离线”；房主离线后转给第一个在线玩家；当前主持人在非拍卖阶段离线时，本日改为系统主持，其他在线玩家可继续推进；新增内部 `AUTO_ADVANCE_OFFLINE` 托管动作，默认离线 45 秒后自动处理反制放弃、英式退出、暗标 0 标，重连会取消托管，测试里可用 `AUCTIONEER_OFFLINE_AUTOPLAY_MS` 缩短。
  - 验证结果：`npm run validate:content` 通过；`npm run test` 通过（35 条）；`npm run test:socket` 通过；`npm run build` 通过；`npm run test:e2e` 通过；`STRESS_SCALE=quick npm run test:stress` 通过；已人工查看刷新恢复、桌面牌桌、移动入口和 web-game 采样截图。
  - 仍未完成：完整倒计时 UI、房主手动踢人/转让、分阶段超时配置、托管后的玩家回归提示、服务器进程重启时恢复未触发离线定时器的补偿扫描、正式数据库替换 JSONL、线上日志/监控和安全部署。

- 2026-06-12 21:03：继续第一阶段稳定性补强：已开始补倒计时 UI、房主手动踢人/转让、每阶段超时配置、托管后玩家回归提示和服务器重启补偿扫描。当前已完成规则侧核心闭环：离线/超时托管会记录托管原因；被踢玩家不能恢复旧会话，也不能用旧 socket 继续操作；大厅踢人不再占用人数；游戏内轮主持和竞拍名单会排除被踢玩家；服务器冷启动恢复房间后会重新安排阶段倒计时和离线托管扫描。下一步跑类型/单测并修正暴露的问题。

- 2026-06-12 21:08：第一阶段稳定性补强继续推进：前端已补倒计时条、房主管理面板和每阶段超时配置表；服务端踢人后会主动向目标玩家发送会话失效错误，前端收到后清除旧 session 并回到入口页；如果只收到房间更新，前端也会根据自己的 kicked 状态退出。新增 socket 验证覆盖房主转让、踢人后恢复失败、短阶段超时自动推进，以及服务器重启后补偿扫描离线托管。当前 `npm run test:socket` 通过（socket-flow、recovery、file-recovery、compensation-recovery）。下一步跑完整验证和浏览器截图复查。

- 2026-06-12 21:14：修正并补充本轮完成记录：当前 `http://localhost:5173/` 对应的 Vite 前端进程来自 `E:\code\拍卖\code`，`localhost:3001` 后端进程来自同目录 `apps/server/src/index.ts`；实时 socket 探测确认新增 `room:transferOwner`、`room:setTimeouts`、`room:kick` 已在当前运行服务生效。完成内容包括：倒计时 UI、房主手动转让/踢人、八个阶段的超时秒数配置、托管后玩家回归提示、服务器重启后阶段倒计时与离线托管补偿扫描。完整验证通过：`npm run validate:content`、`npm run build`、`npm run test`（35 条）、`npm run test:socket`（socket-flow、recovery、file-recovery、compensation-recovery）、`npm run test:e2e`、`STRESS_SCALE=quick npm run test:stress`。已人工查看 `output/e2e/desktop-host.png`、`output/e2e/resume-after-refresh.png`、`output/e2e/target-modal-card.png`、`output/e2e/desktop-winner.png`、`output/e2e/mobile-entry.png`、`output/web-game/shot-0.png`，未发现空白页、严重遮挡或目标弹窗失效。当前估计：可放心内测进度约 92%，v1.0 工程规格约 82%；仍不是上架发售版，后续还要做正式数据库/备份、线上日志监控、安全部署、弱网测试、长时间 soak 和发行 QA。

- 2026-06-12 22:52：第一优先级商业化风险修复已完成，并将后续记录统一写入 `E:\code\拍卖\code\progress.md`；旧的 `E:\code\拍卖\progreaa.md` 视为过期临时记录，不再继续维护。本轮完成内容：
  - 安全漏洞：已升级生产依赖并验证 `npm audit --omit=dev --json` 为 0 个生产漏洞。关键版本包括 `fastify@5.8.5`、`@fastify/cors@11.2.0`；`vite@8.0.16`、`@vitejs/plugin-react@6.0.2`、`vitest@4.1.8` 等构建/测试依赖已放在 devDependencies。
  - CORS：生产环境不再允许 `origin: true`，必须通过 `AUCTIONEER_ALLOWED_ORIGINS` 显式配置白名单；开发/测试默认只放行 `http://localhost:5173` 和 `http://127.0.0.1:5173`。
  - 限流：已新增 HTTP 与 Socket.IO 内存滑动窗口限流，覆盖 `room:create`、`room:join`、`room:resume` 和普通游戏动作；触发后返回 `RATE_LIMITED`，并已将该错误码补入共享类型。
  - 生产存储：正式启动默认仓储已改为 SQLite，使用 `AUCTIONEER_REPOSITORY=sqlite`，路径来自 `AUCTIONEER_SQLITE_PATH` 或 `AUCTIONEER_DATA_DIR/auctioneer.sqlite`；仍保留 `jsonl` 与 `memory` 作为兼容/测试模式。SQLite 表已覆盖 actions、snapshots、sessions，并建立 `room_id + action_index`、`room_id + player_id` 索引，启用 WAL 与 NORMAL synchronous。
  - `logOnly` 清理：内容生成脚本不再产出 `logOnly`；已经由引擎自动实现的效果改为 `resolver: engine:<id>`；未来不能自动结算的文本效果应使用 `manualTextOnly`。内容校验脚本会禁止 `logOnly` 重新进入内容库，并改用稳定 deep hash 生成内容版本。当前内容版本为 `c006a7e300793187`。
  - 规则安全补丁：引擎在打开反制窗口前会先校验卡牌 payload，避免无效 D02/D06/D07 等动作先创建 pending reaction 再失败，降低状态污染风险。
  - 新增/调整测试：新增 `apps/server/src/security.ts`、`apps/server/test/security.test.ts`；SQLite 冷启动恢复测试已覆盖；规则测试、socket 测试和 E2E 均已按本轮变化调整。
  - 验证结果：`npm audit --omit=dev --json` 通过（0 production vulnerabilities）；`npm run validate:content` 通过（0 errors/0 warnings，contentVersion `c006a7e300793187`）；`npm run build` 通过；`npm run test` 通过（35 passed）；`npm run test:socket` 通过；`npm run test:e2e` 通过；`STRESS_SCALE=quick npm run test:stress` 通过；已复查桌面、刷新恢复、移动入口和 web-game 采样截图，未发现空白页或严重布局遮挡。
  - 已知注意点：当前 SQLite 使用 Node 内置 `node:sqlite`，运行时可能出现 `ExperimentalWarning`。这对工程验证可接受，但商业正式发布前建议评估稳定 SQLite 驱动、PostgreSQL，或固定 Node 版本并写入部署风险说明。

- 2026-06-12 22:52：距离商业发布还需要完成的事项评估如下：
  - 发布结论：第一优先级安全与工程底座已明显加强，当前更接近“可控小范围内测/封闭付费测试”而不是“公开商业发行”。如果只做熟人局、小规模灰度，工程完成度约 75%-80%；如果要公开上架、商业化收费、面向陌生玩家长期运营，整体完成度约 65%-70%，其中合规、运维和发行 QA 是主要缺口。
  - 线上部署硬化：需要 Docker/进程守护/自动重启、健康检查、反向代理与 HTTPS、环境变量和密钥管理、正式域名 CORS 白名单、生产日志目录权限、崩溃恢复演练、备份和恢复策略。
  - 数据库与持久化：需要决定正式数据库方案。若继续 SQLite，需要确认 Node 内置 sqlite 的实验状态是否可接受、锁定 Node 版本、制定备份和迁移；若面向多实例或较高并发，建议改 PostgreSQL。还需要 schema migration、数据保留策略、定时备份、回滚和灾备演练。
  - 限流与防刷：当前限流是单进程内存实现，单机可用；多进程/多实例/云部署需要 Redis、网关限流或 Socket.IO adapter 层面的共享限流。还需要防刷房间、防爆破加入码、IP/设备级频率策略和封禁机制。
  - 监控告警：需要接入结构化日志、错误上报、关键指标和告警。至少监控在线人数、房间数、socket 连接数、ack p95/p99、room action queue 延迟、数据库写入耗时、恢复失败率、进程内存、崩溃次数。
  - 稳定性测试：还需要真实云服务器压测、弱网/高 RTT/丢包测试、移动网络测试、30-60 分钟以上 soak、断线重连风暴、服务器重启恢复、数据库锁竞争、浏览器多端兼容。当前本机 quick/standard 压测不能直接等同线上可承载能力。
  - 游戏完整 QA：需要更多完整长局 E2E 和人工测试，重点覆盖反制链、交易+属性、事件持续时间、角色技能次数重置、委托失败惩罚、终局计分复现、多人同时操作、玩家退出/被踢/回归、每日阶段切换和第 10 天结算。
  - 产品体验：还需要新手教程、规则书、行动提示、错误文案、房间邀请/分享、终局复盘、移动端关键流程打磨、音效/视觉反馈、设置页、已知问题提示和无障碍基础体验。当前功能可玩，但还不像完整商业产品。
  - 内容与平衡：需要封闭测试收集胜率、平均局长、玩家现金曲线、卡牌/角色/委托强弱、负反馈点；然后做数值平衡和内容版本锁定。商业发布前应建立 release candidate 内容冻结流程。
  - 账号/支付/运营：如果要收费或长期运营，需要账号体系或平台登录、订单/支付/退款、客服入口、反馈系统、公告、版本更新机制、封禁/申诉、用户数据导出/删除流程。
  - 法务与合规：中国大陆公开商业运营通常需要重点评估 ICP 备案、公安备案、隐私政策、用户协议、个人信息保护、未成年人保护/防沉迷/实名认证，以及网络游戏出版相关资质和版号路径。若通过 Steam、itch、海外站点或私域测试，要求会不同，但隐私、支付、退款和平台规则仍要逐项确认。
  - 发行材料：需要商店页文案、Logo/key art、截图、预告片、玩法说明、隐私政策链接、用户协议链接、客服邮箱、Press kit、更新日志和发行候选版本号。
  - 建议下一步最高优先级：先做“商业发布前闭环清单 v1”：确定发行地区和平台；确定是否收费；确定正式数据库；搭建一套真实云端 staging；接入日志/监控/备份；跑 1 小时 soak 和弱网测试；同时整理隐私政策、用户协议、规则书和新手教程。完成这些之后，再判断是否进入公开测试或商店上架准备。

- 2026-06-12 22:55：如果目标收窄为“自己和朋友玩”，且不考虑高并发、公开收费、陌生人运营和商店上架，那么剩余门槛会明显降低。当前工程已经接近可朋友局试玩的状态，核心还差：
  - 一键启动/部署说明：需要给非开发者一个清晰入口，例如本地启动说明、局域网/公网访问说明、环境变量示例、数据目录说明、如何重启服务、如何清空测试数据。
  - 稳定朋友局验证：至少用 3-5 人真实浏览器跑完 1-2 局完整游戏，记录卡住点、误解点、规则争议和重连体验。机器压测已经过，但真实朋友局会暴露“看不懂/不知道点哪里/误操作”的问题。
  - 规则说明与新手引导：不需要商业级教程，但至少要有一页可打开的规则摘要、阶段说明、卡牌/角色/委托说明、常见问题。朋友第一次玩时不能只靠开发者口头解释。
  - 错误提示与操作反馈：需要把最常见的失败原因说成人话，例如现金不足、不是你的阶段、目标无效、已被反制、等待别人操作、断线恢复中。
  - 房间恢复兜底：当前已有自动 resume、踢人/转让/托管/倒计时，但朋友局前最好再确认：刷新页面能回来、关浏览器再进能回来、服务端重启后房间还能恢复、被踢/掉线不会把整局卡死。
  - 数据备份与清理：朋友局不需要复杂数据库运维，但需要知道 SQLite 文件在哪、怎么备份、怎么删除旧房间、怎么避免测试数据无限增长。
  - 移动端关键流程：如果朋友用手机玩，要重点复查加入房间、手牌操作、目标选择、出价/喊停、终局查看这些流程，保证不遮挡、不误触。
  - 已知问题清单：开局前写清楚“哪些情况还可能不完美”，例如长时间挂机、极端反制链、刷新后个别提示不够清楚、手机小屏体验待优化。朋友局可接受问题，但不能让大家毫无预期。
  - 最小上线方式：可选方案是本机局域网、Tailscale/ZeroTier 私网、云服务器单实例。朋友局推荐先用单实例 + SQLite + 固定域名/HTTPS 或私网访问，不必立刻做多实例、Redis、PostgreSQL 和复杂网关。
  - 当前判断：若只是 3-5 个朋友小范围试玩，工程进度约 85%-90%；真正差的是“可理解、可启动、可恢复、可解释”。建议下一步优先做朋友局启动文档、规则摘要页、常见错误文案优化，然后组织一次完整真人测试。

- 2026-06-12 23:17：开始按朋友局 UI/规则反馈修复，并使用 GSAP React/Core/Performance 工作流。已完成第一批底层改动：
  - 规则层：预展推进不再由主持人选择拍卖方式，改为每天按房间/天数/动作序号随机生成英式、荷兰式、暗标或打包拍卖；打包内层也随机英式/荷兰式/暗标。
  - 暂停：新增房间级暂停状态 `room:setPaused`，暂停时阶段倒计时停止，恢复时按剩余时间顺延；暂停期间除连接、房主管理、恢复暂停外的游戏动作会被拒绝。
  - 信息视图：`PlayerView` 新增 `privateLog`；藏品视图新增 `purchasePrice`，用于展示“到手价/成交价”，避免玩家把买到的东西误解成声望。
  - 隐私记录：黑市购买会公开“某玩家花多少钱买了 1 张锦囊/事件卡”，但具体卡名只写入该玩家个人记录；使用锦囊/事件卡时，公共记录不再默认暴露卡名和目标，自己的操作记录会写明使用了哪张、对谁/哪个藏品使用。
  - 服务端：Socket 已接入 `room:setPaused`，暂停状态下不会继续安排阶段超时定时器。
  - 下一步：重构前端为单屏牌桌，接入 GSAP scoped 动画，拆分锦囊/事件手牌区，所有用牌进入确认弹窗，右上角设置里放暂停和新手教程。

- 2026-06-13 10:48：继续补齐“每天随机拍卖”的外部入口安全口子：
  - Socket 层 `host:setAuction` 已改为明确拒绝，返回“拍卖方式由系统随机生成。”，避免玩家通过浏览器控制台或脚本绕过随机拍卖规则。
  - 引擎内部 `SET_AUCTION` 暂时保留为规则单测钩子，用于精确复现英式/荷兰式/暗标/打包边界；真实客户端路径不再可调用。
  - `socket-flow` 新增断言：手动设置拍卖必须失败。
  - `recovery.test.ts` 不再调用手动拍卖接口，改为创建随机暗标房间后验证重启恢复、暗标隐私和离线补偿。
  - `stress.test.ts` 不再调用手动拍卖接口：普通负载跟随随机拍卖自然结算，荷兰式并发喊停和暗标恢复通过“随机到目标模式后继续测试”保证覆盖。
  - 已验证：`npx tsc --noEmit --project apps/server/tsconfig.json` 通过；`npm run test:socket` 通过；`STRESS_SCALE=quick npm run test:stress` 通过。
  - 下一步：跑完整 `validate:content`、`build`、`test`、`test:e2e`，并复查最新浏览器截图和状态 JSON。

- 2026-06-13 10:54：朋友局 UI/规则反馈本轮完成并验证：
  - 前端已完成单屏牌桌：顶部状态栏、左侧公共信息/公共池/我的操作、中间行动与拍品、右侧玩家/角色/锦囊/事件/我的藏品；页面整体不需要上下翻动，局部列表内部滚动。
  - 已接入 GSAP React/Core/Performance 模式：使用 scoped `useGSAP`，动画集中在入场/阶段提示等 transform/opacity 场景，避免布局抖动。
  - 手牌已拆分为“锦囊”和“事件卡”；使用卡牌前会弹窗确认或选择目标，不能直接误点生效。
  - 到手藏品显示“到手价/成交价”，不再把成交价误写成声望；教程文案也明确“终局才按每 50 银元折算声望”。
  - 拍卖方式每天由系统随机生成，主持人不能再通过 socket 手动指定。
  - 信息隐私已按朋友局需求收紧：公共池只显示阶段、拍卖方式、当前拍品/公开价格、公开日志；使用锦囊/事件和目标只进入自己的“我的操作”记录。E2E 状态 JSON 显示公共日志为“今日随机拍卖方式 / 竞拍开始 / 谁以多少钱拍下什么”，没有泄露用牌细节。
  - 右上角设置已包含暂停/恢复、房主管理、阶段超时配置和新手教程。
  - 已验证：`npm audit --omit=dev --json` 通过（生产漏洞 0）；`npm run validate:content` 通过（contentVersion `c006a7e300793187`，0 errors/0 warnings）；`npm run build` 通过；`npm run test` 通过（35 passed）；`npm run test:socket` 通过；`STRESS_SCALE=quick npm run test:stress` 通过；`npm run test:e2e` 通过；develop-web-game Playwright 客户端采样通过。
  - 已人工复查截图：`output/e2e/desktop-host.png`、`output/e2e/desktop-winner.png`、`output/e2e/target-modal-card.png`、`output/e2e/mobile-entry.png`、`output/e2e/settings-modal.png`、`output/web-game/shot-0.png`。未发现空白页、严重遮挡、整页滚动依赖或弹窗不可用。
  - 当前 dev 服务已重启并运行在 `http://localhost:5173`（前端）和 `http://localhost:3001`（后端）。注意：本地 `output/e2e/debug-blank.png` 是旧调试截图，不代表当前状态。
  - 朋友局剩余建议：组织 3-5 人完整跑一局，记录看不懂的文案、误点、断线恢复和终局结算理解问题；补一份“朋友局启动/清数据/备份 SQLite/局域网或公网访问”说明；再做一次手机真实设备流程检查。

- 2026-06-13 11:49：继续修复本轮朋友局反馈：已把锦囊/事件的私人日志顺序改为先写使用记录、再写真实效果结果，避免玩家看到最新一条只像“使用了卡”而不是效果；`render_game_to_text` 已补角色名、私人操作、晨间骰子结果和玩家手牌/事件数量；E2E 脚本已新增角色揭示、Tab 玩家信息、晨间骰子三张截图验证入口。下一步跑单测、构建、E2E 和截图复查。

- 2026-06-13 11:56：第一轮规则/构建验证已通过：`npm run test:unit` 36 条通过，`shared`、`engine`、`server`、`web` 构建通过，`npm run validate:content` 通过。首轮 E2E 已跑到拍卖阶段，但随机英式拍卖中“退出”按钮被状态刷新替换导致脚本点击超时；已把 E2E 的退出点击改为短超时、可重试的可见按钮点击，准备重跑。

- 2026-06-13 12:00：本轮“更动态 + 信息结果 + Tab 玩家信息 + 角色揭示”修复完成并验证：
  - 晨间收入已展示 4 名玩家的骰子面板，配合 GSAP 入场/骰子翻动动画；E2E 已新增 `output/e2e/dice-roll.png`，并修正截图等待，避免拍到动画中途。
  - 使用锦囊/事件后，“我的操作”现在先记录使用，再把真实效果结果作为最新记录；已验证 `开棺验尸` 会显示“完整属性：易损”，规则单测也改为检查 I06/I12 的最新私人日志分别包含“属性倾向”和“当前现金排名”。
  - `I08/I09/I12` 这类全体/无目标信息牌在前端保持无目标确认流程；D/I 类需要目标的卡仍打开目标选择弹窗。
  - 已新增 LoL 式 Tab 玩家信息层：按住 Tab 显示、松开隐藏，里面展示所有玩家昵称、角色、状态、现金、藏品数、锦囊数、事件卡数；E2E 已新增 `output/e2e/scoreboard-tab.png`。
  - 开局角色揭示弹窗已验证，显示“恭喜你抽到了……”和技能列表；E2E 已新增 `output/e2e/role-reveal.png`。
  - `render_game_to_text` 已包含 `privateLog`、`lastIncomeRolls`、玩家 `roleName`、手牌数和事件数，便于后续自动化检查隐私与 UI 状态。
  - 验证结果：`npm run validate:content` 通过；`npm run build` 通过；`npm run test` 通过（36 passed）；`npm run test:socket` 通过；`npm run test:e2e` 通过；`$env:STRESS_SCALE='quick'; npm run test:stress` 通过；`npm audit --omit=dev --json` 通过（生产漏洞 0）；develop-web-game Playwright 客户端采样通过。
  - 已人工复查截图：`output/e2e/role-reveal.png`、`output/e2e/scoreboard-tab.png`、`output/e2e/dice-roll.png`、`output/e2e/desktop-host.png`、`output/e2e/desktop-winner.png`、`output/e2e/target-modal-card.png`、`output/web-game/shot-0.png`。未发现空白页、严重遮挡或弹窗不可用。

- 2026-06-13 12:25：开始按新 UI/房间反馈继续调整：目标是把公共池搬到中间藏品下方，把暂停/成交/黑市购买等公开行动统一放入公共池；左侧原公共池位置改成角色和技能概览，尽量完整显示不依赖上下滑动；设置里新增“退出房间”，任意玩家确认后全员退出当前房间，旧房间标记关闭并需要重新开房。已完成初步代码改动：共享协议新增 `room:close`，服务端新增关闭房间逻辑和关闭快照标记，前端布局已改为左侧角色技能+我的操作、中间藏品+公共池，E2E 已新增退出确认与关闭回入口流程；下一步跑构建/测试并修正暴露问题。

- 2026-06-13 12:36：本轮“公共池位置 + 左侧角色技能 + 全员退出房间”已完成并验证：
  - 中间牌桌现在上方是行动/晨间骰子与两件藏品，下方是“公共池”；公共池内合并显示阶段、拍卖方式、当前拍品、公开价格和公共行动日志。
  - 暂停/恢复、谁花多少钱买了什么、随机拍卖方式、竞拍开始等公开行动仍走 `view.log`，现在统一在中间公共池里呈现。
  - 左侧原公共池位置已改为角色和技能概览；主动技能可直接从左侧使用，右侧去掉重复角色面板，让手牌/委托/藏品区域更清楚。
  - 设置弹窗新增“退出房间”，点击后先显示确认；确认后服务端触发 `room:close`，所有在线玩家收到 `SESSION_INVALID` 回到入口页，旧 session 清除，旧房间码清空。
  - 服务端关闭房间会写入 `closedAt/closedBy` 快照并从内存房间、房间码、action queue、离线/阶段定时器中清理；后续恢复会跳过已关闭房间，避免服务重启后旧房间复活。
  - socket 测试新增关闭房间覆盖：其他玩家收到会话失效、旧 token 无法恢复、旧房间码无法再加入。
  - E2E 新增/更新截图：`output/e2e/settings-modal.png`、`output/e2e/leave-room-confirm.png`、`output/e2e/room-closed-entry.png`，并继续复查 `desktop-host.png`、`desktop-winner.png`。
  - 验证结果：`npm run validate:content` 通过；`npm run build` 通过；`npm run test` 通过（36 passed）；`npm run test:socket` 通过；`npm run test:e2e` 通过；`$env:STRESS_SCALE='quick'; npm run test:stress` 通过；`npm audit --omit=dev --json` 通过（生产漏洞 0）；develop-web-game Playwright 客户端采样通过。
  - 已人工复查截图：`output/e2e/desktop-host.png`、`output/e2e/desktop-winner.png`、`output/e2e/leave-room-confirm.png`、`output/e2e/room-closed-entry.png`、`output/web-game/shot-0.png`。未发现空白页、严重遮挡或退出流程不可用。

- 2026-06-13 12:41：修复“创建房间的人右上角显示连接异常”的假状态问题。原因是 `room:close` 后前端收到 `SESSION_INVALID` 会把 `connectionStatus` 置为 `failed`，但随后重新创建/加入房间成功时只更新了 `view`，没有把连接状态恢复为 `connected`。已修复为：收到 `room:update` 或任意带 `view` 的成功 ack 时，会按 socket 实际连接状态恢复为 `connected/connecting` 并清空旧错误。E2E 新增回归：关闭房间后重新创建房间，不允许出现 `.connection-pill.failed`；`npm run build --workspace @auctioneer/web` 与 `npm run test:e2e` 已通过。

- 2026-06-13 13:18：收到新一轮朋友局体验需求：每日随机拍卖开始时弹窗提示今天的拍卖方式；买家成交后弹窗显示成交价、真实价格、属性和属性效果，主持人弹窗显示收到的佣金；Tab 玩家信息把自己置顶并标金色，下面展示自己的两个秘密委托；新增按 B 查看背包，显示自己全部藏品的类别、故事、价格、属性；右侧空间主要留给锦囊和事件卡。开始读取前端布局、成交规则和 E2E 脚本，准备做最小范围改动。
- 2026-06-13 13:31：完成第一批实现改动：引擎在成交后给主持人写入私密佣金记录并补单测断言；前端新增通知队列，支持今日拍卖方式弹窗、买家成交详情弹窗和主持佣金弹窗；新增按住 B 打开背包，展示自己藏品的类别/故事/到手价/实际价格/属性效果；Tab 玩家信息改为自己置顶并金色标识，底部显示自己的两个秘密委托；右侧 SelfPanel 已瘦身为锦囊和事件卡为主，只保留现金/贷款/背包提示和借还贷按钮。`npm run build --workspace @auctioneer/web` 已通过。
- 2026-06-13 13:45：本轮“每日拍卖弹窗 + 成交详情 + 主持佣金 + Tab 委托 + B 背包 + 右侧卡牌区”已完成并验证：
  - 每天随机拍卖方式生成后会弹窗提示“今天是英式/荷兰式/暗标/打包拍卖”，E2E 新增 `output/e2e/auction-mode-modal.png`。
  - 买家成交后会弹窗显示买到的藏品、到手价、实际价格、类别/标签、故事、属性名和属性效果，E2E 新增 `output/e2e/purchase-modal.png`。
  - 主持人成交后会收到私密佣金记录和佣金到账弹窗，E2E 新增 `output/e2e/commission-modal.png`；引擎单测已断言主持人私密日志包含佣金。
  - Tab 玩家信息已改为自己第一行、金色标识，并在底部展示自己的两个秘密委托，E2E 继续覆盖 `output/e2e/scoreboard-tab.png`。
  - 按住 B 会打开背包覆盖层，显示自己的全部藏品详情并可卖银行，松开 B 关闭，E2E 新增 `output/e2e/backpack-b.png`。
  - 右侧面板已主要留给锦囊和事件卡；秘密委托挪到 Tab，藏品挪到 B 背包。
  - 修复一个新增弹窗边界：第一笔成交时已见藏品集合为空，不能误判为未初始化；现在第一笔成交也会弹窗。
  - 验证结果：`npm run validate:content` 通过；`npm run build` 通过；`npm run test` 通过（36 passed）；`npm run test:socket` 通过；`npm run test:e2e` 通过；`$env:STRESS_SCALE='quick'; npm run test:stress` 通过；`npm audit --omit=dev --json` 通过（生产漏洞 0）；develop-web-game Playwright 客户端采样通过，并人工查看 `output/web-game/shot-0.png`、`output/e2e/auction-mode-modal.png`、`output/e2e/purchase-modal.png`、`output/e2e/commission-modal.png`、`output/e2e/backpack-b.png`、`output/e2e/scoreboard-tab.png`、`output/e2e/desktop-winner.png`，未发现空白页、严重遮挡或新增弹窗不可用。

- 2026-06-13 13:53：收到新一轮 7 条任务：设置里加入 Tab/B 说明，并让 B 背包和 Tab 一样以中间小长方形区域出现；顶部天数卡从阶段名改为“游戏天数”；事件卡只能在事件阶段使用，使用后我的操作和公共池都要记录，公共池写“今天发生了什么”而不写使用者；所有玩家都能暂停/恢复；整体 UI 要用 GSAP 打磨得更精致华丽；交易模式改为先选玩家再选买/卖、选择商品、输入价格并让对方收到确认弹窗；阶段切换时清理上阶段临时 UI，晨间收入过后隐藏骰子，并解释“到手价”为成交价不是实际价格。开始读取代码和规则入口，按这 7 条逐项实现并验证。

- 2026-06-13 14:05：本轮 7 条任务开始落地第一批规则改动：已允许所有玩家暂停/恢复房间；事件卡后端强制只能在事件窗口使用；事件卡使用后保留自己的用牌记录，并向公共池追加不含使用者的“今日发生：...”叙事日志；PlayerView 为每名玩家补公开藏品列表，供新的买/卖交易流程选择商品。下一步改前端设置说明、B/Tab 小长方形覆盖层、交易确认弹窗和阶段切换清理临时 UI。

- 2026-06-13 14:16：前端第一批交互改动完成：顶部天数卡已改为“游戏天数 / 第 X/10 天”；设置弹窗加入 Tab/B 说明并允许任意玩家点暂停/恢复；事件卡按钮在非事件窗口会置灰，后端仍做强校验；晨间骰子面板只在晨间收入阶段显示，阶段切换会关闭 Tab/B/用牌确认等临时 UI；藏品价格文案改为“到手价（成交价）/ 成交价/到手价”，明确不是实际价格；自由交易面板改为选玩家、买/卖、选商品、输入价格、发起交易，对方会收到居中确认弹窗。

- 2026-06-13 14:27：UI 打磨与规则回归验证推进：已用 GSAP 为 B 背包、成交/拍卖弹窗、当前拍品、公共日志和手牌加入 transform/opacity 动画；CSS 改成更精致的拍卖桌纸面、金色、墨绿和浅灰组合，B 背包收窄为类似 Tab 的中上方小长方形覆盖层；新增引擎单测覆盖事件卡阶段限制、事件公共叙事不暴露使用者、非房主暂停/恢复。当前 `npm run validate:content`、`npm run build`、`npm run test`（38 passed）、`npm run test:socket`、`npm audit --omit=dev --json` 均通过；下一步跑 E2E、压力测试和截图复查。

- 2026-06-13 14:45：本轮 7 条任务已完成并验证：
  - 设置弹窗首屏已加入 Tab/B 快捷键说明；Tab 与 B 都是按住显示、松开关闭，并且 B 背包已改为中上方小长方形覆盖层。
  - 顶部天数卡已改为“游戏天数 / 第 X/10 天”。
  - 事件卡只能在事件窗口使用；使用后“我的操作”记录具体用牌，公共池记录不含使用者的“今日发生：...”事件结果。
  - 所有玩家都可以暂停/恢复；房主管理配置仍只给房主。
  - UI 已重新打磨为更精致的拍卖桌风格，并用 GSAP 做当前拍品、手牌、公共日志、骰子、Tab/B/弹窗等 transform/opacity 动画。
  - 自由交易已改为选择玩家、选择买入/卖出、选择商品、输入价格、发起交易；接收方会收到居中交易确认弹窗，可同意或拒绝。
  - 阶段切换会关闭 Tab/B/用牌确认等临时 UI；晨间骰子结算后短暂显示并在进入下一阶段时清理；藏品价格文案明确“到手价”为“成交价”，并和实际价格分开。
  - 验证结果：`npm run validate:content` 通过；`npm run build` 通过；`npm run test` 通过（38 passed）；`npm run test:socket` 通过；`npm run test:e2e` 通过；`$env:STRESS_SCALE='quick'; npm run test:stress` 通过；`npm audit --omit=dev --json` 通过（生产漏洞 0）；develop-web-game Playwright 采样通过。已人工查看 `output/e2e/desktop-host.png`、`output/e2e/backpack-b.png`、`output/e2e/settings-modal.png`、`output/e2e/purchase-modal.png`、`output/e2e/trade-offer-modal.png`，未发现空白页、严重遮挡或新增流程不可用。

- 2026-06-13 15:04：收到“完善到可部署服务器、朋友局保证流程正确”的新目标。当前判断：不能承诺“完美达到所有策划标准”，但已接近朋友局可部署；本轮重点转为部署闭环和朋友局稳定性。已完成生产部署工程改造：新增 `build:prod` 与 `start:prod`；服务端生产产物改为 `node apps/server/dist/index.js` 直接运行，不再依赖 `tsx`；服务端可托管 `apps/web/dist`，前后端同端口部署；前端未配置 `VITE_SERVER_URL` 时自动使用同源 Socket；生成内容改成纯 TS 常量，避免生产 Node ESM JSON import 问题；新增 `test:prod-smoke`，可启动生产产物并跑完整浏览器 E2E；新增 `.env.production.example`、`DEPLOY_FRIENDS.md`、`scripts/start-prod-windows.ps1` 和 `deploy/auctioneer-friends.service`。已验证 `npm run build:prod` 与 `npm run test:prod-smoke` 通过；下一步跑完整验证链和截图复查。

- 2026-06-13 14:49：完成“朋友局可部署服务器状态”的收尾复核：
  - 结论：不能诚实地说“已经完美达到所有策划案标准/商业级零风险”，但以“单台服务器 + SQLite + 3-5 个朋友一起玩”为目标，当前已经具备可部署、可开房、可恢复、流程自动化验证通过的状态。
  - 部署链路已打通：`npm run build:prod` 通过，生产模式会由后端同端口托管 `apps/web/dist`，前端默认使用同源 Socket.IO，不再要求朋友分别访问前后端两个端口。
  - 生产烟测已通过：`npm run test:prod-smoke` 会启动生产产物并跑浏览器 E2E，本轮结果为 `prod-smoke ok http://127.0.0.1:4173`。
  - 完整验证链本轮均通过：`npm run validate:content` 通过（contentVersion `c006a7e300793187`，240 藏品、31 属性、43 锦囊、30 事件、52 委托、9 角色，0 errors/0 warnings）；`npm audit --omit=dev --json` 通过（生产依赖漏洞 0）；`npm run build:prod` 通过；`npm run test` 通过（38 passed）；`npm run test:socket` 通过；`npm run test:e2e` 通过；`STRESS_SCALE=quick npm run test:stress` 通过。
  - 快速压力结果：5 房/20 玩家、荷兰式冲突抢停、3 房/12 玩家恢复场景均无 unexpected errors；冲突场景里的 expectedRuleErrors 是刻意制造的规则拒绝，不是失败。
  - 截图复查完成：重新查看最新 `output/e2e/desktop-host.png`、`desktop-winner.png`、`settings-modal.png`、`trade-offer-modal.png`、`backpack-b.png`、`purchase-modal.png`，未发现空白页、关键按钮不可见、弹窗严重偏位或主要流程无法操作。
  - 部署材料已补齐：`.env.production.example`、`DEPLOY_FRIENDS.md`、`scripts/start-prod-windows.ps1`、`deploy/auctioneer-friends.service`。上线前按文档设置 `AUCTIONEER_ALLOWED_ORIGINS` 为朋友实际访问的网址，开放端口，确认 `/health`，并保留 SQLite 备份。
  - 已知边界：当前是朋友局单机部署，不建议多个 Node 实例共用一个 SQLite 文件；Node 24 的 `node:sqlite` 会打印 ExperimentalWarning，可接受但要记录；商业公开运营仍需要更长时间 soak、弱网真机、日志告警、备份恢复演练和更多人工 QA。
  - 给下一个接手者的 TODO：正式约朋友开玩前，建议用 4 个真实浏览器/设备完整跑 1 天到终局或至少跑完随机拍卖、事件窗口、自由交易、断线刷新恢复、退出房间这几个关键环节；如果只是在朋友间玩，这一步通过后就可以上线。
