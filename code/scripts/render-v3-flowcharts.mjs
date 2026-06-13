import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..", "..");
const outDir = path.join(rootDir, "image", "v3_flowcharts");

const kind = {
  setup: { bg: "#eef6ff", border: "#2f6fed", accent: "#2f6fed" },
  day: { bg: "#f2fbf5", border: "#2f9d59", accent: "#2f9d59" },
  black: { bg: "#fff5db", border: "#d18a00", accent: "#d18a00" },
  host: { bg: "#f5efff", border: "#7a52c7", accent: "#7a52c7" },
  auction: { bg: "#eef8f8", border: "#188b91", accent: "#188b91" },
  item: { bg: "#fff4f0", border: "#d46a3a", accent: "#d46a3a" },
  card: { bg: "#f3f7ff", border: "#3e64b5", accent: "#3e64b5" },
  event: { bg: "#fff0f5", border: "#c94d7c", accent: "#c94d7c" },
  economy: { bg: "#f0fbec", border: "#5a9f33", accent: "#5a9f33" },
  risk: { bg: "#fff0ee", border: "#c94c3d", accent: "#c94c3d" },
  end: { bg: "#f7f1e5", border: "#a56a1b", accent: "#a56a1b" },
  decision: { bg: "#f7f7f7", border: "#6e7781", accent: "#6e7781" },
  system: { bg: "#f5f7fa", border: "#64748b", accent: "#64748b" },
};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cssStyle(style) {
  return Object.entries(style)
    .map(([key, value]) => `${key}:${value}`)
    .join(";");
}

function nodeById(nodes, id) {
  const node = nodes.find((item) => item.id === id);
  if (!node) throw new Error(`Missing node: ${id}`);
  return node;
}

function anchor(node, side = "bottom") {
  const x = node.x;
  const y = node.y;
  const w = node.w;
  const h = node.h;
  if (side === "top") return { x: x + w / 2, y };
  if (side === "bottom") return { x: x + w / 2, y: y + h };
  if (side === "left") return { x, y: y + h / 2 };
  if (side === "right") return { x: x + w, y: y + h / 2 };
  return { x: x + w / 2, y: y + h / 2 };
}

function pathForEdge(nodes, edge) {
  const from = anchor(nodeById(nodes, edge.from), edge.fromSide);
  const to = anchor(nodeById(nodes, edge.to), edge.toSide || "top");
  const points = [from, ...(edge.points || []), to];
  if (!edge.points) {
    if ((edge.fromSide || "bottom") === "bottom" && (edge.toSide || "top") === "top") {
      const midY = Math.round((from.y + to.y) / 2);
      points.splice(1, 0, { x: from.x, y: midY }, { x: to.x, y: midY });
    } else if ((edge.fromSide || "right") === "right" && (edge.toSide || "left") === "left") {
      const midX = Math.round((from.x + to.x) / 2);
      points.splice(1, 0, { x: midX, y: from.y }, { x: midX, y: to.y });
    } else if ((edge.fromSide || "left") === "left" && (edge.toSide || "right") === "right") {
      const midX = Math.round((from.x + to.x) / 2);
      points.splice(1, 0, { x: midX, y: from.y }, { x: midX, y: to.y });
    }
  }
  const d = points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
  const labelPoint = points[Math.floor(points.length / 2)];
  return { d, labelPoint };
}

function renderNode(node) {
  const palette = kind[node.kind || "system"] || kind.system;
  const body = Array.isArray(node.body) ? node.body : String(node.body || "").split("\n");
  const meta = node.meta ? `<div class="meta">${escapeHtml(node.meta)}</div>` : "";
  const classes = ["node", node.shape === "decision" ? "decision" : "", node.compact ? "compact" : ""]
    .filter(Boolean)
    .join(" ");
  return `<div class="${classes}" style="${cssStyle({
    left: `${node.x}px`,
    top: `${node.y}px`,
    width: `${node.w}px`,
    height: `${node.h}px`,
    "--bg": palette.bg,
    "--border": palette.border,
    "--accent": palette.accent,
  })}">
    <div class="node-title">${escapeHtml(node.title)}</div>
    <div class="node-body">${body.map((line) => `<div>${escapeHtml(line)}</div>`).join("")}</div>
    ${meta}
  </div>`;
}

function renderGroup(group) {
  return `<div class="group" style="${cssStyle({
    left: `${group.x}px`,
    top: `${group.y}px`,
    width: `${group.w}px`,
    height: `${group.h}px`,
    "--group-color": group.color || "#94a3b8",
    "--group-bg": group.bg || "rgba(248, 250, 252, 0.72)",
  })}">
    <div class="group-title">${escapeHtml(group.title)}</div>
  </div>`;
}

function renderDiagram(diagram) {
  const edgeMarkup = (diagram.edges || [])
    .map((edge) => {
      const palette = kind[edge.kind || "system"] || kind.system;
      const { d, labelPoint } = pathForEdge(diagram.nodes, edge);
      const label = edge.label
        ? `<text class="edge-label" x="${labelPoint.x + (edge.labelDx || 0)}" y="${labelPoint.y + (edge.labelDy || -10)}">${escapeHtml(edge.label)}</text>`
        : "";
      return `<path d="${d}" class="edge" style="--edge:${edge.color || palette.accent}"></path>${label}`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(diagram.title)}</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #eceff3;
    font-family: "Microsoft YaHei", "Noto Sans CJK SC", "PingFang SC", Arial, sans-serif;
    color: #17202a;
  }
  .board {
    position: relative;
    width: ${diagram.width}px;
    height: ${diagram.height}px;
    background:
      linear-gradient(90deg, rgba(148, 163, 184, 0.12) 1px, transparent 1px),
      linear-gradient(rgba(148, 163, 184, 0.12) 1px, transparent 1px),
      #ffffff;
    background-size: 40px 40px;
    overflow: hidden;
  }
  .title {
    position: absolute;
    left: 58px;
    top: 34px;
    right: 58px;
    font-size: 40px;
    font-weight: 800;
    letter-spacing: 0;
  }
  .subtitle {
    position: absolute;
    left: 60px;
    top: 88px;
    right: 60px;
    color: #566274;
    font-size: 22px;
  }
  .group {
    position: absolute;
    border: 2px dashed var(--group-color);
    background: var(--group-bg);
    border-radius: 20px;
    z-index: 0;
  }
  .group-title {
    position: absolute;
    left: 18px;
    top: -18px;
    padding: 3px 12px;
    border-radius: 999px;
    background: #ffffff;
    color: #334155;
    border: 1px solid var(--group-color);
    font-size: 19px;
    font-weight: 750;
  }
  .edges {
    position: absolute;
    left: 0;
    top: 0;
    width: ${diagram.width}px;
    height: ${diagram.height}px;
    z-index: 1;
    overflow: visible;
  }
  .edge {
    fill: none;
    stroke: var(--edge);
    stroke-width: 4;
    stroke-linecap: round;
    stroke-linejoin: round;
    marker-end: url(#arrow);
    opacity: 0.9;
  }
  .edge-label {
    font-size: 18px;
    fill: #334155;
    font-weight: 720;
    paint-order: stroke;
    stroke: white;
    stroke-width: 7px;
    stroke-linejoin: round;
  }
  .node {
    position: absolute;
    z-index: 2;
    border: 3px solid var(--border);
    background: var(--bg);
    border-radius: 18px;
    padding: 16px 18px 13px;
    box-shadow: 0 12px 24px rgba(15, 23, 42, 0.12);
    overflow: hidden;
  }
  .node::before {
    content: "";
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 9px;
    background: var(--accent);
  }
  .node-title {
    font-size: 25px;
    line-height: 1.18;
    font-weight: 850;
    margin-left: 4px;
    margin-bottom: 9px;
    letter-spacing: 0;
  }
  .node-body {
    font-size: 20px;
    line-height: 1.32;
    color: #273444;
    margin-left: 4px;
  }
  .node-body div + div { margin-top: 3px; }
  .node.compact .node-title { font-size: 22px; margin-bottom: 6px; }
  .node.compact .node-body { font-size: 18px; line-height: 1.26; }
  .node.decision {
    border-radius: 26px;
    border-style: dashed;
  }
  .meta {
    position: absolute;
    right: 12px;
    bottom: 9px;
    color: #64748b;
    font-size: 15px;
    font-weight: 700;
  }
  .note {
    position: absolute;
    z-index: 3;
    color: #475569;
    font-size: 18px;
    line-height: 1.35;
  }
</style>
</head>
<body>
  <main class="board">
    <div class="title">${escapeHtml(diagram.title)}</div>
    <div class="subtitle">${escapeHtml(diagram.subtitle || "")}</div>
    ${(diagram.groups || []).map(renderGroup).join("\n")}
    <svg class="edges" viewBox="0 0 ${diagram.width} ${diagram.height}" aria-hidden="true">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#334155"></path>
        </marker>
      </defs>
      ${edgeMarkup}
    </svg>
    ${diagram.nodes.map(renderNode).join("\n")}
    ${(diagram.notes || []).map((note) => `<div class="note" style="${cssStyle({ left: `${note.x}px`, top: `${note.y}px`, width: `${note.w}px` })}">${escapeHtml(note.text)}</div>`).join("\n")}
  </main>
</body>
</html>`;
}

const diagrams = [
  {
    file: "01_整局流程总览",
    title: "拍卖师法则 v3 整局流程总览",
    subtitle: "10 个拍卖日被第 3/6/9 天黑市切成三段；第 10 天拍卖后进入终局声望结算",
    width: 2600,
    height: 1750,
    groups: [
      { title: "开局配置", x: 60, y: 138, w: 2480, h: 270, color: "#2f6fed" },
      { title: "10 天主循环", x: 60, y: 470, w: 2480, h: 520, color: "#2f9d59" },
      { title: "结算与策略骨架", x: 60, y: 1060, w: 2480, h: 540, color: "#a56a1b" },
    ],
    nodes: [
      { id: "mode", kind: "setup", x: 120, y: 205, w: 320, h: 145, title: "选择模式", body: ["桌游 / 本地多人", "数字版人机 / 联机房间", "人数 3-5 人"] },
      { id: "res", kind: "setup", x: 500, y: 205, w: 350, h: 145, title: "初始资源", body: ["每人 500 银元", "锦囊 2 张；事件 1 张", "事件持有上限 3 张"] },
      { id: "role", kind: "host", x: 910, y: 205, w: 350, h: 145, title: "角色与技能", body: ["角色抽 2 选 1", "主动 / 被动技能", "锚定预展、竞拍、黑市、终局"] },
      { id: "task", kind: "end", x: 1320, y: 205, w: 350, h: 145, title: "秘密委托", body: ["委托抽 2 选 1", "自己隐藏至终局", "完成得 8-15 声望"] },
      { id: "host0", kind: "host", x: 1730, y: 205, w: 350, h: 145, title: "主持人起点", body: ["第 1 天抽签 / 随机", "之后顺时针轮换", "无主持人日不打断顺延"] },
      { id: "deck", kind: "item", x: 2140, y: 205, w: 330, h: 145, title: "牌库准备", body: ["藏品、锦囊、事件、委托", "藏品出现即生成赝品/属性", "信息按层级隐藏"] },

      { id: "d1", kind: "day", x: 95, y: 590, w: 210, h: 150, title: "第 1 天", body: ["普通拍卖日", "开荒期", "试探性竞拍"], compact: true },
      { id: "d2", kind: "day", x: 335, y: 590, w: 210, h: 150, title: "第 2 天", body: ["普通拍卖日", "资金仍充裕", "初步看路线"], compact: true },
      { id: "d3", kind: "black", x: 575, y: 590, w: 210, h: 150, title: "第 3 天", body: ["黑市日 1", "先购物再预展", "中期资源补充"], compact: true },
      { id: "d4", kind: "day", x: 815, y: 590, w: 210, h: 150, title: "第 4 天", body: ["普通拍卖日", "缠斗期", "信息开始流动"], compact: true },
      { id: "d5", kind: "day", x: 1055, y: 590, w: 210, h: 150, title: "第 5 天", body: ["普通拍卖日", "锦囊发力", "事件预埋后续"], compact: true },
      { id: "d6", kind: "black", x: 1295, y: 590, w: 210, h: 150, title: "第 6 天", body: ["黑市日 2", "调整战术路线", "补反制/信息"], compact: true },
      { id: "d7", kind: "day", x: 1535, y: 590, w: 210, h: 150, title: "第 7 天", body: ["普通拍卖日", "冲刺期", "套装/委托抢点"], compact: true },
      { id: "d8", kind: "day", x: 1775, y: 590, w: 210, h: 150, title: "第 8 天", body: ["普通拍卖日", "现金吃紧", "终局布局"], compact: true },
      { id: "d9", kind: "black", x: 2015, y: 590, w: 210, h: 150, title: "第 9 天", body: ["黑市日 3", "最后补给", "4 人局无主持"], compact: true },
      { id: "d10", kind: "end", x: 2255, y: 590, w: 210, h: 150, title: "第 10 天", body: ["最后拍卖", "3/4 人局无主持", "拍后终局结算"], compact: true },

      { id: "loop", kind: "system", x: 180, y: 800, w: 590, h: 120, title: "普通日通用循环", body: ["晨间收入 -> 预展 -> 锦囊 -> 竞拍/成交 -> 事件 -> 自由阶段"], compact: true },
      { id: "market", kind: "black", x: 870, y: 800, w: 590, h: 120, title: "黑市日插入点", body: ["晨间收入之后、预展之前：每人最多买 2 张，锦囊 30，事件 50"], compact: true },
      { id: "nohost", kind: "host", x: 1560, y: 800, w: 760, h: 120, title: "无主持人日", body: ["系统 0 起拍、英式每次 +10；公开名称+类别+故事；无佣金，流拍弃置"], compact: true },

      { id: "daily", kind: "day", x: 130, y: 1135, w: 520, h: 310, title: "每日核心产出", body: ["现金变化：收入、出价、佣金、交易、贷款", "信息变化：传闻、故事、属性探查、后续事件公开", "藏品变化：成交、流拍自吞/弃置、交易转移", "局势变化：竞拍后事件影响后续、套装争夺、委托暴露风险"] },
      { id: "hostrot", kind: "host", x: 710, y: 1135, w: 520, h: 310, title: "主持人轮换", body: ["3 人局：每人 3 次，第 10 天无主持", "4 人局：每人 2 次，第 9/10 天无主持", "5 人局：每人 2 次，无无主持人日", "主持人不能竞拍自己主持的藏品"] },
      { id: "routes", kind: "decision", x: 1290, y: 1135, w: 490, h: 310, title: "三种获胜路线", body: ["稳健路线：低买高卖、套装与委托", "信息路线：锦囊探价、事件扰动套利", "主持人路线：推高成交赚佣金，判断流拍自吞"] },
      { id: "score", kind: "end", x: 1840, y: 1135, w: 600, h: 310, title: "终局声望", body: ["现金：每 50 银元 = 1 声望", "藏品：终局价值合计 ÷ 50 向下取整", "套装：2/3/4 件 = +4/+10/+18", "秘密委托：完成得标注声望", "属性与贷款：增减值、诅咒、强制清算"] },
    ],
    edges: [
      { from: "mode", to: "res", fromSide: "right", toSide: "left", kind: "setup" },
      { from: "res", to: "role", fromSide: "right", toSide: "left", kind: "setup" },
      { from: "role", to: "task", fromSide: "right", toSide: "left", kind: "setup" },
      { from: "task", to: "host0", fromSide: "right", toSide: "left", kind: "setup" },
      { from: "host0", to: "deck", fromSide: "right", toSide: "left", kind: "setup" },
      ...Array.from({ length: 9 }, (_, index) => ({ from: `d${index + 1}`, to: `d${index + 2}`, fromSide: "right", toSide: "left", kind: index + 1 === 2 || index + 1 === 5 || index + 1 === 8 ? "black" : "day" })),
      { from: "d1", to: "loop", kind: "day", label: "普通日" },
      { from: "d3", to: "market", kind: "black", label: "黑市补货" },
      { from: "d9", to: "nohost", kind: "host", label: "人数相关" },
      { from: "loop", to: "daily", kind: "day" },
      { from: "market", to: "daily", kind: "black" },
      { from: "nohost", to: "hostrot", kind: "host" },
      { from: "daily", to: "routes", fromSide: "right", toSide: "left", kind: "decision" },
      { from: "routes", to: "score", fromSide: "right", toSide: "left", kind: "end" },
      { from: "d10", to: "score", kind: "end", label: "拍卖后" },
    ],
  },

  {
    file: "02_拍卖日详细流程",
    title: "拍卖日详细流程",
    subtitle: "普通日、黑市日、无主持人日共用同一主链；黑市与无主持人规则是插入/替换模块",
    width: 2500,
    height: 2050,
    groups: [
      { title: "日初与日型判断", x: 60, y: 135, w: 2380, h: 390, color: "#64748b" },
      { title: "预展与信息层级", x: 60, y: 565, w: 2380, h: 400, color: "#d46a3a" },
      { title: "竞拍前锦囊", x: 60, y: 1005, w: 2380, h: 340, color: "#3e64b5" },
      { title: "竞拍、成交与竞拍后事件", x: 60, y: 1385, w: 2380, h: 410, color: "#188b91" },
      { title: "自由阶段与收尾", x: 60, y: 1835, w: 2380, h: 170, color: "#5a9f33" },
    ],
    nodes: [
      { id: "start", kind: "system", x: 120, y: 205, w: 330, h: 120, title: "拍卖日开始", body: ["读取天数、人数、主持人指针", "第 1-10 天每日执行"], compact: true },
      { id: "income", kind: "economy", x: 520, y: 205, w: 340, h: 120, title: "晨间收入", body: ["掷 1-6 点", "收入 = 点数 × 10 银元", "先知道预算再决策"], compact: true },
      { id: "type", kind: "decision", shape: "decision", x: 940, y: 185, w: 330, h: 150, title: "今天是什么日？", body: ["普通日", "第 3/6/9 天黑市日", "3/4 人局无主持人日"], compact: true },
      { id: "bm", kind: "black", x: 1345, y: 160, w: 390, h: 165, title: "黑市购物", body: ["晨间收入后、预展前", "每人最多买 2 张", "锦囊 30；事件 50", "事件卡超过 3 张不能买"], compact: true },
      { id: "hostday", kind: "host", x: 1810, y: 160, w: 500, h: 165, title: "无主持人日替换规则", body: ["系统 0 起拍，强制英式，每次 +10", "名称+类别+故事对所有人公开", "无主持人佣金，流拍直接弃置"], compact: true },

      { id: "preview", kind: "item", x: 120, y: 640, w: 390, h: 150, title: "预展 2 件藏品", body: ["所有人至少看到名称 + 类别", "藏品出现时已完成隐藏判定", "当天两件按顺序处理"], compact: true },
      { id: "hostinfo", kind: "host", x: 580, y: 610, w: 390, h: 170, title: "主持人信息", body: ["故事背景", "传闻价值区间", "不知道成交后的基准结算价", "不知道属性"], compact: true },
      { id: "publicinfo", kind: "system", x: 1040, y: 610, w: 390, h: 170, title: "普通玩家信息", body: ["名称 + 类别", "不知道故事、传闻区间、属性", "可靠锦囊/技能探查"], compact: true },
      { id: "hidden", kind: "item", x: 1500, y: 610, w: 390, h: 170, title: "全盲层", body: ["20% 赝品判定", "非赝品抽 1-2 个属性", "成交前仅系统记录"], compact: true },
      { id: "method", kind: "auction", x: 1960, y: 610, w: 350, h: 170, title: "随机拍卖模式", body: ["系统每天随机 1 种：英式 / 荷兰 / 暗标 / 打包", "主持人按今日模式执行", "无主持人日固定英式"], compact: true },

      { id: "cardphase", kind: "card", x: 180, y: 1085, w: 410, h: 160, title: "锦囊阶段", body: ["每天最多使用 2 张", "主要在本阶段使用", "部分锦囊可在竞拍中即时使用"], compact: true },
      { id: "order", kind: "system", x: 675, y: 1085, w: 410, h: 160, title: "同时使用顺序", body: ["多人同时声明时", "从当前主持人开始", "按顺时针依次结算"], compact: true },
      { id: "event", kind: "event", x: 1140, y: 1660, w: 430, h: 120, title: "竞拍后事件窗口", body: ["当天全部竞拍/成交结算后", "每天最多触发 1 个事件", "只影响后续，不回溯当天"], compact: true },
      { id: "natural", kind: "event", x: 1645, y: 1660, w: 430, h: 120, title: "无人使用事件", body: ["20% 概率触发自然事件", "从自然事件池抽 1 张", "作为后续局势生效"], compact: true },

      { id: "auction", kind: "auction", x: 120, y: 1460, w: 410, h: 170, title: "竞拍开始", body: ["主持人起拍并讲述故事", "主持人不能竞拍自己藏品", "无主持人日由系统主持"], compact: true },
      { id: "bid", kind: "decision", x: 615, y: 1460, w: 410, h: 170, title: "玩家竞价决策", body: ["加价 / 跟进 / 喊停 / 暗标 / 退出", "检查现金、贷款、锦囊、委托与套装需求"], compact: true },
      { id: "sold", kind: "auction", x: 1110, y: 1435, w: 410, h: 195, title: "成功成交", body: ["赢家支付成交价", "主持人即时获得成交价 20% 佣金", "成交价是现金成本，不等于结算价"], compact: true },
      { id: "reveal", kind: "item", x: 1605, y: 1435, w: 410, h: 195, title: "买家专享揭晓", body: ["立即抽出基准结算价", "揭晓属性 / 赝品结果", "只有买家可见；他人只知道成交价"], compact: true },
      { id: "pass", kind: "risk", x: 2100, y: 1435, w: 300, h: 195, title: "流拍分支", body: ["普通主持人：最低值 ×50% 自吞", "无主持人日：弃置", "荷兰式：主持人不得自吞"], compact: true },

      { id: "free", kind: "economy", x: 330, y: 1875, w: 500, h: 105, title: "拍卖后自由阶段", body: ["银行出售、玩家交易、贷款、整理手牌与藏品"], compact: true },
      { id: "next", kind: "system", x: 1010, y: 1875, w: 500, h: 105, title: "日末更新", body: ["记录事件持续状态、易损费用、主持人指针、进入下一天"], compact: true },
      { id: "final", kind: "end", x: 1690, y: 1875, w: 500, h: 105, title: "若是第 10 天", body: ["拍卖结束后进入终局结算：贷款、藏品、套装、委托、声望"], compact: true },
    ],
    edges: [
      { from: "start", to: "income", fromSide: "right", toSide: "left", kind: "system" },
      { from: "income", to: "type", fromSide: "right", toSide: "left", kind: "economy" },
      { from: "type", to: "bm", fromSide: "right", toSide: "left", label: "黑市日", kind: "black" },
      { from: "type", to: "hostday", fromSide: "right", toSide: "left", label: "无主持", kind: "host", points: [{ x: 1300, y: 410 }, { x: 1810, y: 410 }] },
      { from: "type", to: "preview", kind: "system", label: "普通日" },
      { from: "bm", to: "preview", fromSide: "bottom", toSide: "top", kind: "black", points: [{ x: 1540, y: 535 }, { x: 315, y: 535 }] },
      { from: "hostday", to: "preview", fromSide: "bottom", toSide: "top", kind: "host", points: [{ x: 2060, y: 535 }, { x: 315, y: 535 }] },
      { from: "preview", to: "hostinfo", fromSide: "right", toSide: "left", kind: "item" },
      { from: "hostinfo", to: "publicinfo", fromSide: "right", toSide: "left", kind: "host" },
      { from: "publicinfo", to: "hidden", fromSide: "right", toSide: "left", kind: "item" },
      { from: "hidden", to: "method", fromSide: "right", toSide: "left", kind: "auction" },
      { from: "method", to: "cardphase", kind: "auction", points: [{ x: 2135, y: 995 }, { x: 385, y: 995 }] },
      { from: "cardphase", to: "order", fromSide: "right", toSide: "left", kind: "card" },
      { from: "order", to: "auction", kind: "card", points: [{ x: 880, y: 1365 }, { x: 325, y: 1365 }] },
      { from: "auction", to: "bid", fromSide: "right", toSide: "left", kind: "auction" },
      { from: "bid", to: "sold", fromSide: "right", toSide: "left", label: "有赢家", kind: "auction" },
      { from: "sold", to: "reveal", fromSide: "right", toSide: "left", kind: "item" },
      { from: "bid", to: "pass", fromSide: "right", toSide: "left", label: "无人有效出价", kind: "risk", points: [{ x: 1065, y: 1660 }, { x: 2100, y: 1660 }] },
      { from: "reveal", to: "event", kind: "event", points: [{ x: 1810, y: 1645 }, { x: 1355, y: 1645 }] },
      { from: "pass", to: "event", fromSide: "left", toSide: "right", kind: "event" },
      { from: "event", to: "natural", fromSide: "right", toSide: "left", label: "无人用", kind: "event" },
      { from: "event", to: "free", label: "有人用", kind: "event", points: [{ x: 1355, y: 1815 }, { x: 580, y: 1815 }] },
      { from: "natural", to: "free", kind: "event", points: [{ x: 1860, y: 1815 }, { x: 580, y: 1815 }] },
      { from: "free", to: "next", fromSide: "right", toSide: "left", kind: "economy" },
      { from: "next", to: "final", fromSide: "right", toSide: "left", label: "第10天", kind: "end" },
    ],
  },

  {
    file: "03_主持人系统与每日随机拍卖模式",
    title: "主持人系统与每日随机拍卖模式",
    subtitle: "拍卖模式由系统每天随机决定；主持人的策略是在给定模式下定起拍、控节奏、讲故事和判断流拍风险",
    width: 2550,
    height: 1850,
    groups: [
      { title: "主持人准备", x: 60, y: 135, w: 2430, h: 330, color: "#7a52c7" },
      { title: "随机池中的四种拍卖方式", x: 60, y: 520, w: 2430, h: 870, color: "#188b91" },
      { title: "结果处理", x: 60, y: 1445, w: 2430, h: 340, color: "#a56a1b" },
    ],
    nodes: [
      { id: "assign", kind: "host", x: 120, y: 205, w: 320, h: 145, title: "当天主持人", body: ["按顺时针轮换", "3/4 人局末段可能无主持", "主持人日仍拿晨间收入"], compact: true },
      { id: "adv", kind: "host", x: 505, y: 205, w: 350, h: 145, title: "信息优势", body: ["可见故事背景", "可见传闻价值区间", "不可见属性与成交后基准价"], compact: true },
      { id: "limit", kind: "risk", x: 920, y: 205, w: 350, h: 145, title: "硬性限制", body: ["不能竞拍自己主持的藏品", "暗标时只负责收集和唱标", "荷兰式不得靠流拍自吞"], compact: true },
      { id: "leak", kind: "decision", x: 1335, y: 205, w: 350, h: 145, title: "社交操作", body: ["可主动泄露部分信息", "可塑造故事与稀缺感", "也可冷处理诱导流拍"], compact: true },
      { id: "goal", kind: "end", x: 1750, y: 205, w: 360, h: 145, title: "收益目标", body: ["成功卖出：成交价 ×20% 佣金", "流拍自吞：最低值 ×50% 买入"], compact: true },
      { id: "choose", kind: "auction", x: 2175, y: 205, w: 250, h: 145, title: "系统抽模式", body: ["每天随机 1 种", "主持人不能选择", "打包则合并当天 2 件"], compact: true },

      { id: "eng1", kind: "auction", x: 120, y: 600, w: 430, h: 165, title: "英式拍卖", body: ["公开升价，默认方式", "起拍价通常为最低值 ×20%-40%", "建议加价幅度 10-30"], compact: true },
      { id: "eng2", kind: "decision", x: 120, y: 805, w: 430, h: 205, title: "主持人策略", body: ["低起拍引流：0-20 吸引多人", "中起拍试探：最低值 ×30%", "高起拍筛选：最低值 ×50%+", "快速加价：每次 30+ 压缩轮次"], compact: true },
      { id: "eng3", kind: "auction", x: 120, y: 1050, w: 430, h: 175, title: "玩家过程", body: ["依次加价 / 跟进 / 退出", "直到只剩最高出价者", "公开比富，适合制造气氛"], compact: true },

      { id: "dut1", kind: "auction", x: 690, y: 600, w: 430, h: 165, title: "荷兰式拍卖", body: ["公开降价", "主持人设高起始价", "固定时间和幅度降价"], compact: true },
      { id: "dut2", kind: "decision", x: 690, y: 805, w: 430, h: 205, title: "主持人策略", body: ["快降引流：冷门品快速成交", "慢降钓价：等待识货人", "高起低降：制造心理落差", "起拍前确定后不可更改"], compact: true },
      { id: "dut3", kind: "risk", x: 690, y: 1050, w: 430, h: 175, title: "防滥用规则", body: ["第一个喊停者成交", "若无人喊停，主持人不能自吞", "防止极高起拍价劝退所有人"], compact: true },

      { id: "seal1", kind: "auction", x: 1260, y: 600, w: 430, h: 165, title: "暗标拍卖", body: ["所有玩家同时秘密出价", "同时开标，最高者成交", "支付自己的出价金额"], compact: true },
      { id: "seal2", kind: "decision", x: 1260, y: 805, w: 430, h: 205, title: "心理博弈", body: ["不能交流出价信息", "猜对手心理价位", "适合传闻上限 >150 的高价值品", "容易出现溢价"], compact: true },
      { id: "seal3", kind: "host", x: 1260, y: 1050, w: 430, h: 175, title: "主持人职责", body: ["收集密封出价", "不得透露任何人的报价", "平局时抽签决定赢家"], compact: true },

      { id: "pack1", kind: "auction", x: 1830, y: 600, w: 430, h: 165, title: "打包拍卖", body: ["仅限当天 2 件藏品", "合成一个整体拍品", "不能跨日，不能拆分"], compact: true },
      { id: "pack2", kind: "decision", x: 1830, y: 805, w: 430, h: 205, title: "价值重组", body: ["整体估值、整体出价", "适合套装或委托争夺", "可能让单件冷门品被带动"], compact: true },
      { id: "pack3", kind: "auction", x: 1830, y: 1050, w: 430, h: 175, title: "成交规则", body: ["打包之后按英式加价购买", "赢家一次性获得两件", "成交后逐件揭晓结算价与属性"], compact: true },

      { id: "sold", kind: "end", x: 190, y: 1515, w: 470, h: 165, title: "成功卖出", body: ["赢家付款", "主持人即时拿成交价 20% 佣金", "再处理买家专享揭晓与属性"], compact: true },
      { id: "fail", kind: "risk", x: 775, y: 1515, w: 470, h: 165, title: "流拍", body: ["普通主持人：以传闻最低值一半自吞", "无主持人日：弃置", "荷兰式：主持人不得自吞"], compact: true },
      { id: "next", kind: "system", x: 1360, y: 1515, w: 470, h: 165, title: "继续处理当天拍品", body: ["逐件拍卖或打包一次处理", "更新现金、藏品归属、已生效事件影响", "进入自由阶段"], compact: true },
      { id: "abuse", kind: "risk", x: 1945, y: 1515, w: 370, h: 165, title: "关键防线", body: ["主持人知道传闻但不知属性", "不能竞拍自己藏品", "无主持人日无佣金"], compact: true },
    ],
    edges: [
      { from: "assign", to: "adv", fromSide: "right", toSide: "left", kind: "host" },
      { from: "adv", to: "limit", fromSide: "right", toSide: "left", kind: "host" },
      { from: "limit", to: "leak", fromSide: "right", toSide: "left", kind: "risk" },
      { from: "leak", to: "goal", fromSide: "right", toSide: "left", kind: "end" },
      { from: "goal", to: "choose", fromSide: "right", toSide: "left", kind: "auction" },
      { from: "choose", to: "eng1", kind: "auction", points: [{ x: 2300, y: 500 }, { x: 335, y: 500 }] },
      { from: "choose", to: "dut1", kind: "auction", points: [{ x: 2300, y: 500 }, { x: 905, y: 500 }] },
      { from: "choose", to: "seal1", kind: "auction", points: [{ x: 2300, y: 500 }, { x: 1475, y: 500 }] },
      { from: "choose", to: "pack1", kind: "auction", points: [{ x: 2300, y: 500 }, { x: 2045, y: 500 }] },
      { from: "eng1", to: "eng2", kind: "auction" },
      { from: "eng2", to: "eng3", kind: "decision" },
      { from: "dut1", to: "dut2", kind: "auction" },
      { from: "dut2", to: "dut3", kind: "risk" },
      { from: "seal1", to: "seal2", kind: "auction" },
      { from: "seal2", to: "seal3", kind: "host" },
      { from: "pack1", to: "pack2", kind: "auction" },
      { from: "pack2", to: "pack3", kind: "auction" },
      { from: "eng3", to: "sold", kind: "end", points: [{ x: 335, y: 1415 }, { x: 425, y: 1415 }] },
      { from: "dut3", to: "sold", kind: "end", points: [{ x: 905, y: 1415 }, { x: 425, y: 1415 }] },
      { from: "seal3", to: "sold", kind: "end", points: [{ x: 1475, y: 1415 }, { x: 425, y: 1415 }] },
      { from: "pack3", to: "sold", kind: "end", points: [{ x: 2045, y: 1415 }, { x: 425, y: 1415 }] },
      { from: "sold", to: "next", fromSide: "right", toSide: "left", kind: "end" },
      { from: "fail", to: "next", fromSide: "right", toSide: "left", kind: "risk" },
      { from: "next", to: "abuse", fromSide: "right", toSide: "left", kind: "risk" },
    ],
  },

  {
    file: "04_藏品信息属性与赝品生命周期",
    title: "藏品信息层级、赝品与属性生命周期",
    subtitle: "每件藏品在预展出现时已完成隐藏判定；成交后只向买家揭晓结算价和属性",
    width: 2500,
    height: 2050,
    groups: [
      { title: "信息可见性", x: 60, y: 135, w: 720, h: 760, color: "#64748b" },
      { title: "隐藏生成", x: 835, y: 135, w: 760, h: 760, color: "#d46a3a" },
      { title: "成交揭晓", x: 1650, y: 135, w: 790, h: 760, color: "#188b91" },
      { title: "终局价值", x: 60, y: 955, w: 2380, h: 900, color: "#a56a1b" },
    ],
    nodes: [
      { id: "appear", kind: "item", x: 120, y: 220, w: 500, h: 150, title: "藏品进入预展", body: ["每个拍卖日出现 2 件", "卡面含名称、类别、故事、传闻区间", "系统同时建立隐藏记录"], compact: true },
      { id: "public", kind: "system", x: 120, y: 420, w: 500, h: 145, title: "公开层", body: ["名称 + 类别", "所有玩家可见", "用于判断套装、委托、基础兴趣"], compact: true },
      { id: "hostlayer", kind: "host", x: 120, y: 610, w: 500, h: 145, title: "主持人层", body: ["故事背景 + 传闻价值区间", "仅主持人可见", "可用来推销或诱导流拍"], compact: true },
      { id: "nohostlayer", kind: "host", x: 120, y: 800, w: 500, h: 120, title: "无主持人日公开层", body: ["名称 + 类别 + 故事公开", "不公开传闻区间和属性"], compact: true },

      { id: "hidden", kind: "item", x: 895, y: 220, w: 520, h: 145, title: "全盲层生成", body: ["属性效果与赝品结果", "成交前全部隐藏", "部分锦囊/技能可提前探查"], compact: true },
      { id: "fakecheck", kind: "decision", shape: "decision", x: 955, y: 410, w: 400, h: 150, title: "20% 赝品判定", body: ["预展出现时即判定", "玩家不可见，仅系统记录"], compact: true },
      { id: "fake", kind: "risk", x: 895, y: 610, w: 520, h: 140, title: "若为赝品", body: ["只有「赝品」属性", "结算价值 ×30%", "不计入任何套装奖励"], compact: true },
      { id: "attrcount", kind: "item", x: 895, y: 800, w: 520, h: 145, title: "若非赝品", body: ["50% 获得 1 个属性", "50% 获得 2 个属性", "同一藏品不重复属性"], compact: true },

      { id: "pool", kind: "item", x: 1690, y: 220, w: 540, h: 160, title: "属性池", body: ["增益：聚宝、传世、真品、热门、珍藏", "负面：易损、诅咒、仿品、来路不明", "特殊：假一赔三、保险、无名"], compact: true },
      { id: "probe", kind: "card", x: 1690, y: 440, w: 540, h: 145, title: "竞拍前探查入口", body: ["信息类锦囊", "角色技能", "事件造成的信息公开"], compact: true },
      { id: "sold", kind: "auction", x: 1690, y: 640, w: 540, h: 145, title: "成交时触发揭晓", body: ["赢家付款后立即结算", "random(传闻下限, 传闻上限) 取整", "得出基准结算价"], compact: true },
      { id: "buyer", kind: "item", x: 1690, y: 830, w: 540, h: 120, title: "买家专享信息", body: ["基准结算价 + 属性 / 赝品结果", "其他玩家只知道成交价"], compact: true },

      { id: "base", kind: "auction", x: 180, y: 1060, w: 480, h: 150, title: "成交价 vs 结算价", body: ["成交价：玩家支付的现金成本", "结算价：终局计分用价值", "两者可以完全不同"], compact: true },
      { id: "formula", kind: "end", x: 760, y: 1060, w: 660, h: 150, title: "藏品终局价值公式", body: ["基准结算价 × (1 + 属性%) × (1 + 已生效事件%)", "赝品按规则折为 30%", "事件只影响触发后的后续结算"], compact: true },
      { id: "attrfx", kind: "item", x: 1520, y: 1060, w: 600, h: 150, title: "属性影响示例", body: ["聚宝：所有藏品终局价值 +15%", "传世：每过一天本藏品 +2%", "诅咒：条件满足时扣 10 声望"], compact: true },
      { id: "sets", kind: "end", x: 180, y: 1285, w: 480, h: 150, title: "套装判断", body: ["同系列 2/3/4 件 = +4/+10/+18 声望", "赝品不计入套装", "交易后按最终持有人计算"], compact: true },
      { id: "events", kind: "event", x: 760, y: 1285, w: 660, h: 150, title: "事件叠加", body: ["事件在竞拍后触发", "只影响后续/未来藏品与规则", "不回溯当天已成交藏品"], compact: true },
      { id: "record", kind: "system", x: 1520, y: 1285, w: 600, h: 150, title: "系统记录", body: ["每件藏品保留：基准价、属性、已生效事件乘数、持有人", "终局直接读取，不再重新随机"], compact: true },
      { id: "score", kind: "end", x: 520, y: 1530, w: 1460, h: 160, title: "终局进入声望", body: ["所有藏品终局价值合计 ÷ 50 向下取整，再加套装、委托、现金与属性声望修正"], compact: true },
    ],
    edges: [
      { from: "appear", to: "public", kind: "item" },
      { from: "public", to: "hostlayer", kind: "system" },
      { from: "hostlayer", to: "nohostlayer", kind: "host" },
      { from: "appear", to: "hidden", fromSide: "right", toSide: "left", kind: "item" },
      { from: "hidden", to: "fakecheck", kind: "item" },
      { from: "fakecheck", to: "fake", label: "是", kind: "risk" },
      { from: "fakecheck", to: "attrcount", label: "否", kind: "item" },
      { from: "attrcount", to: "pool", fromSide: "right", toSide: "left", kind: "item", points: [{ x: 1505, y: 872 }, { x: 1505, y: 300 }] },
      { from: "pool", to: "probe", kind: "card" },
      { from: "probe", to: "sold", kind: "card" },
      { from: "sold", to: "buyer", kind: "auction" },
      { from: "buyer", to: "base", kind: "item", points: [{ x: 1960, y: 1005 }, { x: 420, y: 1005 }] },
      { from: "base", to: "formula", fromSide: "right", toSide: "left", kind: "end" },
      { from: "formula", to: "attrfx", fromSide: "right", toSide: "left", kind: "item" },
      { from: "formula", to: "sets", kind: "end", points: [{ x: 1090, y: 1245 }, { x: 420, y: 1245 }] },
      { from: "formula", to: "events", kind: "event" },
      { from: "attrfx", to: "record", kind: "system" },
      { from: "sets", to: "score", kind: "end" },
      { from: "events", to: "score", kind: "event" },
      { from: "record", to: "score", kind: "system" },
    ],
  },

  {
    file: "05_竞拍支付不足与流拍处理",
    title: "竞拍、支付不足与流拍处理",
    subtitle: "赢家必须完成付款；不足时先尝试补足，仍不足则由第二高价接手或按流拍处理",
    width: 2500,
    height: 1900,
    groups: [
      { title: "确定赢家", x: 60, y: 135, w: 2380, h: 470, color: "#188b91" },
      { title: "支付校验", x: 60, y: 660, w: 2380, h: 560, color: "#5a9f33" },
      { title: "异常与回退", x: 60, y: 1275, w: 2380, h: 300, color: "#c94c3d" },
      { title: "成交后处理", x: 60, y: 1630, w: 2380, h: 210, color: "#a56a1b" },
    ],
    nodes: [
      { id: "lot", kind: "item", x: 120, y: 215, w: 370, h: 140, title: "开始处理一件拍品", body: ["或打包拍卖的一组拍品", "读取主持人、天数、事件状态"], compact: true },
      { id: "method", kind: "auction", x: 560, y: 215, w: 370, h: 140, title: "按拍卖方式收集出价", body: ["英式：公开加价", "荷兰：第一个喊停", "暗标：同时开标", "打包：整体英式"], compact: true },
      { id: "valid", kind: "decision", shape: "decision", x: 1010, y: 195, w: 330, h: 165, title: "存在有效赢家？", body: ["至少一个合法出价", "主持人不能出价", "暗标平局抽签"], compact: true },
      { id: "winner", kind: "auction", x: 1430, y: 215, w: 370, h: 140, title: "锁定赢家与成交价", body: ["成交价 = 赢家报价", "记录第二高价者", "等待支付校验"], compact: true },
      { id: "nobid", kind: "risk", x: 1870, y: 215, w: 430, h: 140, title: "无人有效出价", body: ["进入流拍分支", "普通主持人可最低值 ×50% 自吞", "无主持 / 荷兰限制按规则弃置"], compact: true },

      { id: "cash", kind: "economy", x: 220, y: 735, w: 420, h: 150, title: "检查现金", body: ["现金是否足以支付成交价？", "成交价只影响现金流", "不等于藏品结算价"], compact: true },
      { id: "enough", kind: "decision", shape: "decision", x: 735, y: 720, w: 340, h: 170, title: "现金足够？", body: ["足够：立即付款", "不足：进入补足选项"], compact: true },
      { id: "supplement", kind: "economy", x: 1165, y: 700, w: 500, h: 210, title: "补足手段", body: ["贷款：每日最多 1 次，借 100", "出售给银行：最低值 ×80%", "玩家交易：双方协商", "现金类锦囊 / 角色技能"], compact: true },
      { id: "after", kind: "decision", shape: "decision", x: 1760, y: 720, w: 340, h: 170, title: "仍能补足？", body: ["能：继续成交", "不能：付款失败"], compact: true },
      { id: "pay", kind: "auction", x: 220, y: 1010, w: 420, h: 140, title: "付款成功", body: ["赢家银元扣除成交价", "藏品所有权转移给赢家", "玩家交易不产生佣金"], compact: true },
      { id: "commission", kind: "host", x: 735, y: 1010, w: 420, h: 140, title: "主持人佣金", body: ["成功拍卖即时获得", "佣金 = 最终实际成交价 ×20%", "无主持人日没有佣金"], compact: true },

      { id: "fail", kind: "risk", x: 210, y: 1345, w: 450, h: 150, title: "付款失败", body: ["该藏品按流拍逻辑处理", "先检查是否存在第二高价者", "主持人佣金按最终实际成交价计算"], compact: true },
      { id: "second", kind: "decision", shape: "decision", x: 760, y: 1330, w: 340, h: 170, title: "第二高价者接手？", body: ["若有第二高价者", "以其出价接手", "否则进入弃置/自吞"], compact: true },
      { id: "takeover", kind: "auction", x: 1200, y: 1345, w: 450, h: 150, title: "第二高价成交", body: ["重新执行支付校验", "成交价改为第二高价", "佣金按新成交价"], compact: true },
      { id: "pass", kind: "risk", x: 1750, y: 1345, w: 500, h: 150, title: "最终流拍", body: ["普通主持人：传闻最低值 ×50% 自吞", "无主持人日：弃置", "荷兰式：主持人不得因流拍获得"], compact: true },

      { id: "base", kind: "item", x: 180, y: 1675, w: 520, h: 115, title: "买家专享揭晓", body: ["random(传闻下限, 上限) 得基准结算价；揭晓属性/赝品"], compact: true },
      { id: "trigger", kind: "event", x: 820, y: 1675, w: 520, h: 115, title: "触发效果", body: ["已生效事件乘数、角色技能、委托记录、属性即时效果"], compact: true },
      { id: "next", kind: "system", x: 1460, y: 1675, w: 520, h: 115, title: "继续日流程", body: ["下一件拍品 / 打包结束 / 自由阶段"], compact: true },
    ],
    edges: [
      { from: "lot", to: "method", fromSide: "right", toSide: "left", kind: "auction" },
      { from: "method", to: "valid", fromSide: "right", toSide: "left", kind: "auction" },
      { from: "valid", to: "winner", fromSide: "right", toSide: "left", label: "是", kind: "auction" },
      { from: "valid", to: "nobid", fromSide: "right", toSide: "left", label: "否", kind: "risk", points: [{ x: 1400, y: 440 }, { x: 1870, y: 440 }] },
      { from: "winner", to: "cash", kind: "economy", points: [{ x: 1615, y: 630 }, { x: 430, y: 630 }] },
      { from: "cash", to: "enough", fromSide: "right", toSide: "left", kind: "economy" },
      { from: "enough", to: "pay", label: "足够", kind: "economy" },
      { from: "enough", to: "supplement", fromSide: "right", toSide: "left", label: "不足", kind: "economy" },
      { from: "supplement", to: "after", fromSide: "right", toSide: "left", kind: "economy" },
      { from: "after", to: "pay", label: "能", kind: "economy", points: [{ x: 1930, y: 960 }, { x: 430, y: 960 }] },
      { from: "after", to: "fail", label: "不能", kind: "risk", points: [{ x: 1930, y: 1250 }, { x: 435, y: 1250 }] },
      { from: "pay", to: "commission", fromSide: "right", toSide: "left", kind: "host" },
      { from: "fail", to: "second", fromSide: "right", toSide: "left", kind: "risk" },
      { from: "second", to: "takeover", fromSide: "right", toSide: "left", label: "有", kind: "auction" },
      { from: "second", to: "pass", fromSide: "right", toSide: "left", label: "无", kind: "risk", points: [{ x: 1150, y: 1570 }, { x: 1750, y: 1570 }] },
      { from: "takeover", to: "cash", kind: "auction", points: [{ x: 1425, y: 1260 }, { x: 430, y: 1260 }, { x: 430, y: 735 }] },
      { from: "nobid", to: "pass", kind: "risk", points: [{ x: 2085, y: 620 }, { x: 2000, y: 620 }] },
      { from: "commission", to: "base", kind: "item", points: [{ x: 945, y: 1240 }, { x: 440, y: 1240 }, { x: 440, y: 1675 }] },
      { from: "base", to: "trigger", fromSide: "right", toSide: "left", kind: "event" },
      { from: "trigger", to: "next", fromSide: "right", toSide: "left", kind: "system" },
      { from: "pass", to: "next", kind: "system", points: [{ x: 2000, y: 1610 }, { x: 1720, y: 1610 }] },
    ],
  },

  {
    file: "06_锦囊事件与黑市流程",
    title: "锦囊、事件与三次黑市流程",
    subtitle: "黑市提供战术补给；锦囊负责局部扭转，事件负责全局且持续的环境变化",
    width: 2550,
    height: 1950,
    groups: [
      { title: "黑市补给", x: 60, y: 135, w: 2430, h: 430, color: "#d18a00" },
      { title: "锦囊使用", x: 60, y: 625, w: 1190, h: 1050, color: "#3e64b5" },
      { title: "竞拍后事件触发", x: 1300, y: 625, w: 1190, h: 1050, color: "#c94d7c" },
      { title: "回到拍卖日", x: 60, y: 1735, w: 2430, h: 160, color: "#64748b" },
    ],
    nodes: [
      { id: "startHand", kind: "card", x: 120, y: 210, w: 390, h: 145, title: "开局手牌", body: ["锦囊 2 张", "事件 1 张", "锦囊无手牌上限，事件最多 3 张"], compact: true },
      { id: "days", kind: "black", x: 600, y: 210, w: 390, h: 145, title: "三次黑市日", body: ["第 3 天：中期策略资源", "第 6 天：调整战术路线", "第 9 天：终局前最后补给"], compact: true },
      { id: "buy", kind: "black", x: 1080, y: 210, w: 390, h: 145, title: "购买限制", body: ["每人最多购买 2 张", "锦囊 + 事件合计", "晨间收入后、预展前执行"], compact: true },
      { id: "price", kind: "economy", x: 1560, y: 210, w: 390, h: 145, title: "价格", body: ["锦囊 30 银元 / 张", "事件 50 银元 / 张", "事件超过上限时不能继续买"], compact: true },
      { id: "hand", kind: "system", x: 2040, y: 210, w: 350, h: 145, title: "更新手牌", body: ["加入手牌", "记录事件上限", "进入预展"], compact: true },

      { id: "charmTiming", kind: "card", x: 120, y: 705, w: 440, h: 145, title: "锦囊使用时机", body: ["竞拍前锦囊阶段为主", "部分锦囊可在竞拍中即时使用", "一次性消耗，使用后弃置"], compact: true },
      { id: "charmLimit", kind: "card", x: 650, y: 705, w: 440, h: 145, title: "每日限制", body: ["每天最多使用 2 张锦囊", "同阶段多人使用时按顺序结算", "从当前主持人开始顺时针"], compact: true },
      { id: "charmTypes", kind: "card", x: 120, y: 925, w: 970, h: 190, title: "锦囊类型", body: ["信息类：查看传闻区间、判断属性好坏、挖掘隐藏信息", "竞价类：改起拍价、重新加入竞价、改变竞拍节奏", "现金类：影响资金流、银行回收、免保护费", "干扰/反制类：限制对手、取消锦囊或事件效果"], compact: true },
      { id: "charmResolve", kind: "decision", x: 120, y: 1200, w: 440, h: 160, title: "结算目标", body: ["拍品", "玩家", "当前拍卖过程", "现金/交易状态"], compact: true },
      { id: "charmAfter", kind: "system", x: 650, y: 1200, w: 440, h: 160, title: "结算后记录", body: ["弃置已用锦囊", "更新可见信息、出价权限或现金", "继续处理事件或进入竞拍"], compact: true },
      { id: "charmDesign", kind: "decision", x: 220, y: 1450, w: 760, h: 135, title: "设计目标", body: ["锦囊应制造情境反转与信息惊喜，而不是只有简单数值加减"], compact: true },

      { id: "eventUse", kind: "event", x: 1370, y: 705, w: 440, h: 145, title: "竞拍后事件窗口", body: ["当天全部竞拍/成交结算后", "每天最多触发 1 个事件", "不影响当天已结算结果"], compact: true },
      { id: "eventNone", kind: "decision", shape: "decision", x: 1900, y: 705, w: 440, h: 145, title: "无人使用事件？", body: ["竞拍后若无人打事件卡", "进行自然事件判定", "若有人使用则跳过自然事件"], compact: true },
      { id: "natural", kind: "event", x: 1900, y: 925, w: 440, h: 160, title: "自然事件", body: ["20% 概率触发", "从自然事件池抽 1 张", "作为后续局势生效"], compact: true },
      { id: "eventTypes", kind: "event", x: 1370, y: 925, w: 440, h: 300, title: "事件类型", body: ["市场波动：结算价 ±10% / ±20%", "环境变化：拍卖规则变更", "信息浪潮：全局信息公开", "经济政策：影响黑市/银行/现金", "行业震荡：属性或概率规则变化"], compact: true },
      { id: "eventDuration", kind: "event", x: 1900, y: 1165, w: 440, h: 160, title: "持续时间", body: ["从后续指定时点开始", "持续到结算或指定时限", "记录影响范围和到期日"], compact: true },
      { id: "eventApply", kind: "system", x: 1370, y: 1310, w: 440, h: 160, title: "写入后续生效状态", body: ["影响未来藏品终局价值", "影响下一天/后续拍卖规则", "影响后续信息公开与现金规则"], compact: true },
      { id: "eventExamples", kind: "event", x: 1900, y: 1420, w: 440, h: 190, title: "自然事件示例", body: ["市场繁荣 / 经济萧条", "古玩热 / 海关抽查", "富豪入场 / 谣言四起", "黑市打折 / 同乡会"], compact: true },

      { id: "join", kind: "system", x: 360, y: 1775, w: 650, h: 90, title: "回到当天收尾", body: ["事件不会回溯当天竞拍结果，只作为后续局势进入记录"], compact: true },
      { id: "audit", kind: "system", x: 1160, y: 1775, w: 850, h: 90, title: "需要记录的状态", body: ["每日锦囊使用数、今日是否已触发事件、活跃事件、事件生效起点、事件到期、玩家手牌与上限"], compact: true },
    ],
    edges: [
      { from: "startHand", to: "days", fromSide: "right", toSide: "left", kind: "black" },
      { from: "days", to: "buy", fromSide: "right", toSide: "left", kind: "black" },
      { from: "buy", to: "price", fromSide: "right", toSide: "left", kind: "economy" },
      { from: "price", to: "hand", fromSide: "right", toSide: "left", kind: "system" },
      { from: "hand", to: "charmTiming", kind: "card", points: [{ x: 2215, y: 590 }, { x: 340, y: 590 }] },
      { from: "charmTiming", to: "charmLimit", fromSide: "right", toSide: "left", kind: "card" },
      { from: "charmLimit", to: "charmTypes", kind: "card", points: [{ x: 870, y: 900 }, { x: 605, y: 900 }] },
      { from: "charmTypes", to: "charmResolve", kind: "card" },
      { from: "charmResolve", to: "charmAfter", fromSide: "right", toSide: "left", kind: "card" },
      { from: "charmAfter", to: "charmDesign", kind: "decision" },
      { from: "charmAfter", to: "join", kind: "system" },
      { from: "hand", to: "eventUse", kind: "event", points: [{ x: 2215, y: 590 }, { x: 1590, y: 590 }] },
      { from: "eventUse", to: "eventNone", fromSide: "right", toSide: "left", label: "无人用？", kind: "event" },
      { from: "eventNone", to: "natural", label: "是", kind: "event" },
      { from: "eventUse", to: "eventTypes", kind: "event" },
      { from: "natural", to: "eventDuration", kind: "event" },
      { from: "eventTypes", to: "eventApply", kind: "event" },
      { from: "eventDuration", to: "eventApply", fromSide: "left", toSide: "right", kind: "event" },
      { from: "eventDuration", to: "eventExamples", kind: "event" },
      { from: "eventApply", to: "join", kind: "system" },
      { from: "join", to: "audit", fromSide: "right", toSide: "left", kind: "system" },
    ],
  },

  {
    file: "07_经济交易贷款与现金压力",
    title: "经济、交易、贷款与现金压力流程",
    subtitle: "现金既是竞拍燃料，也是终局声望；贷款能救急，但第 10 天还不上会触发强制清算",
    width: 2550,
    height: 1950,
    groups: [
      { title: "资金进入与支出", x: 60, y: 135, w: 2430, h: 440, color: "#5a9f33" },
      { title: "自由阶段行动", x: 60, y: 635, w: 2430, h: 500, color: "#188b91" },
      { title: "贷款链路", x: 60, y: 1195, w: 2430, h: 500, color: "#c94c3d" },
      { title: "终局现金入口", x: 60, y: 1755, w: 2430, h: 140, color: "#a56a1b" },
    ],
    nodes: [
      { id: "cash", kind: "economy", x: 120, y: 210, w: 400, h: 165, title: "现金池", body: ["银元用于竞拍、黑市、保护费、贷款还款", "终局每 50 银元 = 1 声望"], compact: true },
      { id: "inflow", kind: "economy", x: 610, y: 190, w: 520, h: 205, title: "收入来源", body: ["初始资金：500", "每日收入：10-60", "主持人佣金：成交价 ×20%", "出售给银行 / 玩家交易", "角色、事件、委托奖励"], compact: true },
      { id: "outflow", kind: "risk", x: 1220, y: 190, w: 520, h: 205, title: "支出项目", body: ["藏品竞拍：成交价", "锦囊 30 / 事件 50", "易损保护费：5/天/件", "贷款：借 100 还 120", "交易报价与临时补款"], compact: true },
      { id: "budget", kind: "decision", x: 1830, y: 210, w: 500, h: 165, title: "预算判断", body: ["出价前估算：现金 + 可贷款 + 可出售资产", "避免赢拍后无法付款"], compact: true },

      { id: "free", kind: "system", x: 120, y: 710, w: 420, h: 150, title: "拍卖后自由阶段", body: ["可以整理现金与藏品", "为下一天/黑市/终局做准备", "玩家也可随时协商交易"], compact: true },
      { id: "bank", kind: "economy", x: 630, y: 690, w: 430, h: 190, title: "出售给银行", body: ["任意玩家可随时出售", "回收价 = 传闻最低值 ×80%", "出售后移出游戏，不参与计分", "急用钱的保底手段"], compact: true },
      { id: "trade", kind: "auction", x: 1150, y: 690, w: 430, h: 190, title: "玩家间交易", body: ["价格双方自由协商", "交易时公开名称和类别", "不公开传闻区间和属性", "属性随藏品转移"], compact: true },
      { id: "maintain", kind: "item", x: 1670, y: 690, w: 430, h: 190, title: "属性费用", body: ["易损：每天需支付 5 银元保护费", "保护/技能可免疫或减免", "费用会加速现金压力"], compact: true },
      { id: "loanEntry", kind: "risk", x: 680, y: 960, w: 520, h: 125, title: "需要补现金？", body: ["赢拍付款不足、黑市购物、终局前现金缺口时考虑贷款"], compact: true },
      { id: "hold", kind: "decision", x: 1340, y: 960, w: 520, h: 125, title: "不处理也可以", body: ["保留藏品赌终局价值", "保留现金等黑市/关键拍品", "根据委托与套装调整"], compact: true },

      { id: "borrow", kind: "risk", x: 160, y: 1275, w: 440, h: 155, title: "贷款", body: ["每次借 100 银元", "每天最多 1 次", "可提前还款但利息不变"], compact: true },
      { id: "repay", kind: "risk", x: 690, y: 1275, w: 440, h: 155, title: "还款义务", body: ["第 10 天终局必须还 120", "每笔独立结算", "现金先用于还款"], compact: true },
      { id: "check", kind: "decision", shape: "decision", x: 1220, y: 1255, w: 360, h: 185, title: "现金足够还款？", body: ["足够：扣 120", "不足：强制清算"], compact: true },
      { id: "liquidate", kind: "risk", x: 1670, y: 1260, w: 520, h: 175, title: "强制清算", body: ["失去全部剩余现金", "由你选择交出 1 件藏品", "该藏品被没收，不参与计分"], compact: true },
      { id: "nocollect", kind: "risk", x: 970, y: 1515, w: 580, h: 120, title: "若没有藏品可交出", body: ["每差 10 银元扣 1 声望", "这是贷款真正的惩罚点"], compact: true },
      { id: "post", kind: "system", x: 1640, y: 1515, w: 580, h: 120, title: "结清后更新状态", body: ["剩余现金、藏品列表、声望惩罚进入终局公式"], compact: true },

      { id: "cashscore", kind: "end", x: 360, y: 1785, w: 620, h: 80, title: "现金声望", body: ["终局剩余现金 ÷ 50，向下取整"], compact: true },
      { id: "pressure", kind: "decision", x: 1150, y: 1785, w: 900, h: 80, title: "核心张力", body: ["多出价会增加藏品价值机会，但降低现金分与还款安全垫"], compact: true },
    ],
    edges: [
      { from: "cash", to: "inflow", fromSide: "right", toSide: "left", kind: "economy" },
      { from: "inflow", to: "outflow", fromSide: "right", toSide: "left", kind: "economy" },
      { from: "outflow", to: "budget", fromSide: "right", toSide: "left", kind: "risk" },
      { from: "free", to: "bank", fromSide: "right", toSide: "left", kind: "economy" },
      { from: "bank", to: "trade", fromSide: "right", toSide: "left", kind: "auction" },
      { from: "trade", to: "maintain", fromSide: "right", toSide: "left", kind: "item" },
      { from: "free", to: "loanEntry", kind: "risk" },
      { from: "trade", to: "hold", kind: "decision" },
      { from: "loanEntry", to: "borrow", kind: "risk", points: [{ x: 940, y: 1160 }, { x: 380, y: 1160 }] },
      { from: "borrow", to: "repay", fromSide: "right", toSide: "left", kind: "risk" },
      { from: "repay", to: "check", fromSide: "right", toSide: "left", kind: "risk" },
      { from: "check", to: "liquidate", fromSide: "right", toSide: "left", label: "不足", kind: "risk" },
      { from: "check", to: "post", label: "足够", kind: "system", points: [{ x: 1400, y: 1495 }, { x: 1930, y: 1495 }] },
      { from: "liquidate", to: "nocollect", kind: "risk", points: [{ x: 1930, y: 1485 }, { x: 1260, y: 1485 }] },
      { from: "nocollect", to: "post", fromSide: "right", toSide: "left", kind: "risk" },
      { from: "post", to: "cashscore", kind: "end", points: [{ x: 1930, y: 1710 }, { x: 670, y: 1710 }] },
      { from: "cashscore", to: "pressure", fromSide: "right", toSide: "left", kind: "decision" },
      { from: "budget", to: "loanEntry", kind: "risk", points: [{ x: 2080, y: 610 }, { x: 940, y: 610 }] },
    ],
  },

  {
    file: "08_第10天终局结算与胜负判定",
    title: "第 10 天终局结算与胜负判定",
    subtitle: "第 10 天拍卖结束后冻结状态，逐项结算现金、藏品、套装、委托、属性与贷款",
    width: 2550,
    height: 1950,
    groups: [
      { title: "结算入口", x: 60, y: 135, w: 2430, h: 300, color: "#64748b" },
      { title: "强制清算与价值计算", x: 60, y: 495, w: 2430, h: 560, color: "#a56a1b" },
      { title: "声望加总", x: 60, y: 1115, w: 2430, h: 500, color: "#5a9f33" },
      { title: "胜负与仪式感", x: 60, y: 1675, w: 2430, h: 220, color: "#7a52c7" },
    ],
    nodes: [
      { id: "after10", kind: "system", x: 130, y: 210, w: 420, h: 140, title: "第 10 天拍卖结束", body: ["完成最后自由阶段", "冻结交易与藏品归属", "进入终局流程"], compact: true },
      { id: "blackmail", kind: "event", x: 650, y: 210, w: 420, h: 140, title: "终局前反制窗口", body: ["如情报贩子·黑料", "可查看并公开一项委托使其作废", "按技能规则支付成本"], compact: true },
      { id: "reveal", kind: "end", x: 1170, y: 210, w: 420, h: 140, title: "翻牌准备", body: ["整理每名玩家现金、贷款、藏品", "每件藏品已有基准结算价与属性记录"], compact: true },
      { id: "order", kind: "system", x: 1690, y: 210, w: 550, h: 140, title: "推荐结算顺序", body: ["先处理贷款和没收，再算藏品与套装，最后揭委托和总分"], compact: true },

      { id: "loan", kind: "risk", x: 130, y: 575, w: 460, h: 160, title: "贷款清算", body: ["每笔借 100 还 120", "现金不足则强制清算", "没收的藏品不参与计分"], compact: true },
      { id: "itemvalue", kind: "item", x: 680, y: 575, w: 560, h: 160, title: "藏品终局价值", body: ["读取成交时基准价", "叠加属性与已生效事件乘数", "赝品按 30% 折价且不计套装"], compact: true },
      { id: "sets", kind: "end", x: 1330, y: 575, w: 460, h: 160, title: "套装奖励", body: ["同系列 2 件：+4", "同系列 3 件：+10", "同系列 4 件：+18"], compact: true },
      { id: "attr", kind: "item", x: 1880, y: 575, w: 460, h: 160, title: "属性声望修正", body: ["聚宝、传世等增值", "诅咒等负面条件", "易损/保护等最终状态"], compact: true },
      { id: "cash", kind: "economy", x: 300, y: 820, w: 520, h: 135, title: "现金声望", body: ["剩余现金 ÷ 50，向下取整", "贷款清算后再计算"], compact: true },
      { id: "itemscore", kind: "end", x: 1020, y: 820, w: 520, h: 135, title: "藏品声望", body: ["所有藏品终局价值合计 ÷ 50，向下取整"], compact: true },
      { id: "mission", kind: "end", x: 1740, y: 820, w: 520, h: 135, title: "秘密委托", body: ["逐一公开", "满足条件获得标注声望", "不可完成自动弃置，不扣分"], compact: true },

      { id: "sum", kind: "end", x: 160, y: 1190, w: 620, h: 210, title: "总声望公式", body: ["现金声望 + 藏品声望 + 套装奖励 + 秘密委托", "再加属性增益/减值", "再扣贷款强制清算惩罚"], compact: true },
      { id: "tie", kind: "decision", shape: "decision", x: 920, y: 1190, w: 440, h: 210, title: "是否平分？", body: ["若总声望并列", "依次比较：藏品总价值", "剩余现金", "完成委托数量"], compact: true },
      { id: "winner", kind: "end", x: 1500, y: 1190, w: 440, h: 210, title: "胜者判定", body: ["总声望最高者获胜", "比较链仍相同则按玩家约定/共同胜利处理"], compact: true },
      { id: "report", kind: "system", x: 2080, y: 1190, w: 300, h: 210, title: "结算表", body: ["现金", "藏品", "套装", "委托", "修正"], compact: true },

      { id: "ceremony", kind: "host", x: 230, y: 1725, w: 600, h: 110, title: "终局仪式感", body: ["逐一公开秘密委托与真实属性，特别是聚宝、赝品等悬念点"], compact: true },
      { id: "review", kind: "decision", x: 970, y: 1725, w: 600, h: 110, title: "复盘看点", body: ["谁被抬价、谁捡漏、谁靠主持佣金翻盘、谁被贷款清算拖垮"], compact: true },
      { id: "nextgame", kind: "system", x: 1710, y: 1725, w: 560, h: 110, title: "下一局准备", body: ["清空手牌与事件状态，保留可复盘日志/数字版回放"], compact: true },
    ],
    edges: [
      { from: "after10", to: "blackmail", fromSide: "right", toSide: "left", kind: "event" },
      { from: "blackmail", to: "reveal", fromSide: "right", toSide: "left", kind: "end" },
      { from: "reveal", to: "order", fromSide: "right", toSide: "left", kind: "system" },
      { from: "order", to: "loan", kind: "risk", points: [{ x: 1965, y: 470 }, { x: 360, y: 470 }] },
      { from: "loan", to: "itemvalue", fromSide: "right", toSide: "left", kind: "item" },
      { from: "itemvalue", to: "sets", fromSide: "right", toSide: "left", kind: "end" },
      { from: "sets", to: "attr", fromSide: "right", toSide: "left", kind: "item" },
      { from: "loan", to: "cash", kind: "economy" },
      { from: "itemvalue", to: "itemscore", kind: "end" },
      { from: "sets", to: "mission", kind: "end", points: [{ x: 1560, y: 790 }, { x: 2000, y: 790 }] },
      { from: "cash", to: "sum", kind: "end" },
      { from: "itemscore", to: "sum", kind: "end", points: [{ x: 1280, y: 1090 }, { x: 470, y: 1090 }] },
      { from: "mission", to: "sum", kind: "end", points: [{ x: 2000, y: 1090 }, { x: 470, y: 1090 }] },
      { from: "attr", to: "sum", kind: "item", points: [{ x: 2110, y: 1090 }, { x: 470, y: 1090 }] },
      { from: "sum", to: "tie", fromSide: "right", toSide: "left", kind: "decision" },
      { from: "tie", to: "winner", fromSide: "right", toSide: "left", kind: "end" },
      { from: "winner", to: "report", fromSide: "right", toSide: "left", kind: "system" },
      { from: "winner", to: "ceremony", kind: "host", points: [{ x: 1720, y: 1660 }, { x: 530, y: 1660 }] },
      { from: "ceremony", to: "review", fromSide: "right", toSide: "left", kind: "decision" },
      { from: "review", to: "nextgame", fromSide: "right", toSide: "left", kind: "system" },
    ],
  },

  {
    file: "09_玩家单日策略决策树",
    title: "玩家单日策略决策树",
    subtitle: "同一套规则从玩家视角会变成预算、信息、委托、套装、主持收益之间的连续取舍",
    width: 2500,
    height: 1850,
    groups: [
      { title: "日初判断", x: 60, y: 135, w: 2380, h: 330, color: "#64748b" },
      { title: "预展阶段决策", x: 60, y: 520, w: 2380, h: 390, color: "#d46a3a" },
      { title: "竞拍阶段决策", x: 60, y: 965, w: 2380, h: 420, color: "#188b91" },
      { title: "成交后调整", x: 60, y: 1440, w: 2380, h: 340, color: "#5a9f33" },
    ],
    nodes: [
      { id: "budget", kind: "economy", x: 120, y: 215, w: 410, h: 145, title: "确认今日预算", body: ["现金 + 晨间收入", "已用贷款次数", "可卖银行/交易资产", "黑市是否需要留钱"], compact: true },
      { id: "role", kind: "host", x: 620, y: 215, w: 410, h: 145, title: "读取角色技能", body: ["今天是否可用主动技能", "被动技能是否影响黑市/竞价/终局", "技能次数是否已耗尽"], compact: true },
      { id: "mission", kind: "end", x: 1120, y: 215, w: 410, h: 145, title: "检查秘密委托", body: ["需要什么类别/套装/现金/主持收益", "是否应隐藏意图", "是否防对手黑料"], compact: true },
      { id: "hostQ", kind: "decision", shape: "decision", x: 1620, y: 200, w: 340, h: 165, title: "今天我是主持人？", body: ["是：经营成交价", "否：寻找信息优势"], compact: true },
      { id: "hostPlan", kind: "host", x: 2030, y: 215, w: 330, h: 145, title: "主持人执行计划", body: ["读取今日随机模式", "定起拍/降幅/讲述节奏", "判断赚佣金还是诱导流拍"], compact: true },

      { id: "look", kind: "item", x: 120, y: 600, w: 400, h: 150, title: "阅读公开信息", body: ["名称 + 类别", "无主持人日还可见故事", "对照套装与委托需求"], compact: true },
      { id: "valueNeed", kind: "decision", x: 600, y: 600, w: 400, h: 150, title: "值得投入信息吗？", body: ["高价值/关键类别/对手明显想要", "才考虑锦囊或技能探查"], compact: true },
      { id: "info", kind: "card", x: 1080, y: 580, w: 430, h: 190, title: "信息投入", body: ["信息类锦囊：探传闻或属性方向", "技能：预展/竞拍触发", "也可用交易谈判换信息"], compact: true },
      { id: "event", kind: "card", x: 1590, y: 580, w: 430, h: 190, title: "锦囊时机", body: ["竞拍前最多用 2 张锦囊", "部分锦囊可在竞拍中即时使用", "事件留到竞拍后窗口，不影响当天已结算结果"], compact: true },
      { id: "target", kind: "decision", x: 2070, y: 600, w: 310, h: 150, title: "确定目标", body: ["强抢", "抬价", "放弃", "诱导别人买"], compact: true },

      { id: "bidStart", kind: "auction", x: 120, y: 1045, w: 390, h: 160, title: "竞拍开始", body: ["根据今日随机模式调整策略", "英式看资金；荷兰比耐心；暗标猜心理；打包重估总价"], compact: true },
      { id: "max", kind: "economy", x: 590, y: 1045, w: 390, h: 160, title: "设心理上限", body: ["成交成本上限", "含贷款风险与现金声望", "不要只看传闻上限"], compact: true },
      { id: "bluff", kind: "decision", x: 1060, y: 1045, w: 390, h: 160, title: "是否抬价/诈唬？", body: ["抬对手价格", "迫使其贷款", "但自己也可能被套住"], compact: true },
      { id: "winQ", kind: "decision", shape: "decision", x: 1530, y: 1025, w: 340, h: 180, title: "我赢了吗？", body: ["赢：检查支付", "输：看是否拿赏金/信息", "主持人看佣金"], compact: true },
      { id: "pay", kind: "risk", x: 1950, y: 1045, w: 390, h: 160, title: "支付风险", body: ["现金不足先补足", "贷款、卖银行、交易、锦囊", "仍不足则可能让第二高价接手"], compact: true },

      { id: "reveal", kind: "item", x: 160, y: 1515, w: 460, h: 145, title: "若买下藏品", body: ["只自己看到结算价与属性", "更新委托/套装判断", "判断持有、出售或交易"], compact: true },
      { id: "lose", kind: "decision", x: 720, y: 1515, w: 460, h: 145, title: "若没买到", body: ["记录对手可能目标", "准备交易/干扰/下一轮抬价", "保留现金优势"], compact: true },
      { id: "free", kind: "economy", x: 1280, y: 1515, w: 460, h: 145, title: "自由阶段调整", body: ["卖银行回血", "玩家交易换套装/现金", "贷款或提前还款"], compact: true },
      { id: "plan", kind: "system", x: 1840, y: 1515, w: 460, h: 145, title: "更新明日计划", body: ["竞拍后事件是否改写后续局势", "黑市日是否采购", "主持轮次与终局路径"], compact: true },
    ],
    edges: [
      { from: "budget", to: "role", fromSide: "right", toSide: "left", kind: "economy" },
      { from: "role", to: "mission", fromSide: "right", toSide: "left", kind: "host" },
      { from: "mission", to: "hostQ", fromSide: "right", toSide: "left", kind: "decision" },
      { from: "hostQ", to: "hostPlan", fromSide: "right", toSide: "left", label: "是", kind: "host" },
      { from: "hostQ", to: "look", label: "否/共同进入预展", kind: "item", points: [{ x: 1790, y: 500 }, { x: 320, y: 500 }] },
      { from: "hostPlan", to: "look", kind: "host", points: [{ x: 2195, y: 500 }, { x: 320, y: 500 }] },
      { from: "look", to: "valueNeed", fromSide: "right", toSide: "left", kind: "item" },
      { from: "valueNeed", to: "info", fromSide: "right", toSide: "left", label: "值得", kind: "card" },
      { from: "info", to: "event", fromSide: "right", toSide: "left", kind: "event" },
      { from: "event", to: "target", fromSide: "right", toSide: "left", kind: "decision" },
      { from: "target", to: "bidStart", kind: "auction", points: [{ x: 2225, y: 940 }, { x: 315, y: 940 }] },
      { from: "bidStart", to: "max", fromSide: "right", toSide: "left", kind: "economy" },
      { from: "max", to: "bluff", fromSide: "right", toSide: "left", kind: "decision" },
      { from: "bluff", to: "winQ", fromSide: "right", toSide: "left", kind: "auction" },
      { from: "winQ", to: "pay", fromSide: "right", toSide: "left", label: "赢", kind: "risk" },
      { from: "pay", to: "reveal", kind: "item", points: [{ x: 2145, y: 1420 }, { x: 390, y: 1420 }] },
      { from: "winQ", to: "lose", label: "没赢", kind: "decision", points: [{ x: 1700, y: 1420 }, { x: 950, y: 1420 }] },
      { from: "reveal", to: "free", fromSide: "right", toSide: "left", kind: "economy" },
      { from: "lose", to: "free", fromSide: "right", toSide: "left", kind: "economy" },
      { from: "free", to: "plan", fromSide: "right", toSide: "left", kind: "system" },
      { from: "plan", to: "budget", kind: "system", points: [{ x: 2070, y: 1800 }, { x: 80, y: 1800 }, { x: 80, y: 285 }] },
    ],
  },
];

async function renderAll() {
  await mkdir(outDir, { recursive: true });
  const executablePath = await findBrowserExecutable();
  const browser = await chromium.launch({
    headless: true,
    executablePath,
  });
  try {
    for (const diagram of diagrams) {
      const html = renderDiagram(diagram);
      const htmlPath = path.join(outDir, `${diagram.file}.html`);
      const pngPath = path.join(outDir, `${diagram.file}.png`);
      await writeFile(htmlPath, html, "utf8");
      const context = await browser.newContext({
        viewport: { width: diagram.width, height: diagram.height },
        deviceScaleFactor: 1,
      });
      const page = await context.newPage();
      await page.goto(pathToFileURL(htmlPath).href);
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      await page.locator(".board").screenshot({ path: pngPath });
      await context.close();
      console.log(`${diagram.file}.png`);
    }
  } finally {
    await browser.close();
  }
}

async function findBrowserExecutable() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next browser path.
    }
  }

  return undefined;
}

renderAll().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
