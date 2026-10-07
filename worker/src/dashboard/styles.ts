// The dashboard's stylesheet, styled to the Umbraco Cloud Portal design
// system (its colors_and_type.css tokens and component previews): the navy
// top bar, white-lilac page, 12px bordered boxes, the portal's tables, tags,
// buttons and inputs, Lato. Light only, as the portal is. Inlined into each
// page (the content security policy allows inline styles, no script).

export const STYLES = `:root {
  --ucp-color-header-surface: #1b264f; --ucp-color-background: #f7f8fc; --ucp-color-surface: #ffffff;
  --ucp-color-text: #030229; --ucp-color-text-alt: #707b81;
  --ucp-color-divider: #e9edf7; --ucp-color-row-divider: #f0f2f8; --ucp-palette-soft-blue: #cdd7ee;
  --ucp-color-interactive: #1b264f; --ucp-color-interactive-emphasis: #1e2e7a; --ucp-color-default-standalone: #151e3f; --ucp-color-focus: #4f64ff;
  --ucp-palette-dawn-pink: #fae9e8; --ucp-palette-primary-pink: #f5c1bc;
  --ucp-color-positive: #25aa60; --ucp-color-warning: #fad634; --ucp-color-danger: #d22d56;
  --ucp-border-radius-small: 3px; --ucp-border-radius-medium: 6px; --ucp-border-radius-large: 12px;
  --ucp-shadow-depth-1: 0 6px 5px -4px rgba(0, 0, 0, 0.05);
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--ucp-color-background); color: var(--ucp-color-text); font: 15px/1.6 Lato, "Helvetica Neue", Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; }
.top-bar { height: 62px; background: var(--ucp-color-header-surface); color: #fff; display: flex; align-items: center; gap: 12px; padding: 0 24px; }
.top-bar .home { color: #fff; display: flex; }
.top-bar .product { font-size: 15px; font-weight: 700; }
.top-bar .product span { font-weight: 400; color: rgba(255, 255, 255, 0.7); }
.top-bar .user { margin-left: auto; font-size: 13px; color: rgba(255, 255, 255, 0.8); display: flex; align-items: center; gap: 12px; }
.top-bar .user a { color: #fff; font-weight: 700; padding: 6px 12px; border-radius: var(--ucp-border-radius-medium); }
.top-bar .user a:hover { background: #2a3360; text-decoration: none; color: #fff; }
main { width: min(100%, 1600px); margin: 0 auto; padding: 30px 50px 50px; }
.repos { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 24px; }
.repos a { font-size: 13px; padding: 6px 12px; border-radius: var(--ucp-border-radius-medium); background: var(--ucp-color-surface); border: 1px solid var(--ucp-color-divider); color: var(--ucp-color-interactive); }
.repos a:hover { background: var(--ucp-palette-dawn-pink); text-decoration: none; }
.repos a[aria-current="page"] { background: var(--ucp-palette-dawn-pink); border-color: var(--ucp-palette-primary-pink); box-shadow: inset 3px 0 0 var(--ucp-palette-primary-pink); }
.repos .count { font-weight: 400; color: var(--ucp-color-text-alt); margin-left: 4px; }
.crumbs { font-size: 13px; color: var(--ucp-color-text-alt); margin-bottom: 12px; }
.crumbs a { font-weight: 400; }
.section-title { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 18px; }
.eyebrow { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: var(--ucp-color-text-alt); margin-bottom: 4px; }
h1 { margin: 0; font-size: 30px; font-weight: 700; line-height: 1.25; letter-spacing: -.005em; overflow-wrap: anywhere; }
h2 { font-size: 21px; font-weight: 700; margin: 30px 0 12px; }
.refresh { font-size: 12px; color: var(--ucp-color-text-alt); }
.stats { display: grid; grid-template-columns: repeat(3, minmax(0, 220px)); gap: 18px; margin-bottom: 24px; }
.box { background: var(--ucp-color-surface); border: 1px solid var(--ucp-color-divider); border-radius: var(--ucp-border-radius-large); box-shadow: var(--ucp-shadow-depth-1); }
.box.pad { padding: 24px 30px; }
.stat { padding: 18px 20px; }
.stat-title { font-size: 13px; font-weight: 700; color: var(--ucp-color-interactive); }
.stat-value { font-size: 28px; font-weight: 900; color: var(--ucp-color-interactive); letter-spacing: -.01em; line-height: 1.2; margin-top: 6px; }
.facts { display: flex; flex-wrap: wrap; gap: 30px; }
.facts .label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--ucp-color-text-alt); margin-bottom: 4px; }
.lead { margin: 0 0 12px; color: var(--ucp-color-text-alt); }
.table-box { overflow: hidden; }
.wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; min-width: 820px; font-size: 14px; }
thead tr { background: var(--ucp-color-background); }
th { text-align: left; padding: 14px 22px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--ucp-color-text-alt); border-bottom: 1px solid var(--ucp-color-divider); }
td { padding: 12px 22px; border-bottom: 1px solid var(--ucp-color-row-divider); vertical-align: top; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr { transition: background-color .15s; }
tbody tr:hover { background: var(--ucp-palette-dawn-pink); }
th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
a { color: var(--ucp-color-interactive); font-weight: 700; text-decoration: none; transition: color .15s; }
a:hover { color: var(--ucp-color-interactive-emphasis); text-decoration: underline; }
a.quiet { font-weight: 400; color: var(--ucp-color-text-alt); }
:focus-visible { outline: 2px solid var(--ucp-color-focus); outline-offset: 2px; border-radius: var(--ucp-border-radius-small); }
.sub { font-size: 12px; color: var(--ucp-color-text-alt); }
.muted { color: var(--ucp-color-text-alt); font-weight: 400; }
.tag { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; letter-spacing: .01em; padding: 3px 8px; border-radius: var(--ucp-border-radius-small); border: 1px solid transparent; white-space: nowrap; vertical-align: middle; }
.tag .dot { width: 6px; height: 6px; border-radius: 50%; }
.tag.default { background: var(--ucp-color-background); color: var(--ucp-color-interactive); border-color: var(--ucp-palette-soft-blue); }
.tag.quiet { background: #f3f3f5; color: #5d6670; }
.tag.positive { background: #e3f6ec; color: #1e8a50; }
.tag.warning { background: #fef5d6; color: #8a7516; }
.tag.danger { background: #fbe4eb; color: #a82547; }
.tag.running { background: var(--ucp-color-positive); color: #fff; margin-left: 6px; }
.tag.running .dot { background: #fff; }
.empty { padding: 36px 22px; text-align: center; color: var(--ucp-color-text-alt); }
.below { margin-top: 30px; }
.below-small { margin-top: 12px; }
.filters { display: flex; flex-direction: column; gap: 9px; margin-bottom: 18px; }
.pills { display: flex; flex-wrap: wrap; gap: 6px; }
.pill { font-size: 13px; padding: 4px 12px; border-radius: 999px; background: var(--ucp-color-surface); border: 1px solid var(--ucp-color-divider); color: var(--ucp-color-interactive); white-space: nowrap; }
.pill:hover { background: var(--ucp-palette-dawn-pink); text-decoration: none; }
.pill .count { font-weight: 400; color: var(--ucp-color-text-alt); margin-left: 3px; }
.pill[aria-current] { background: var(--ucp-color-interactive); border-color: var(--ucp-color-interactive); color: #fff; }
.pill[aria-current] .count { color: rgba(255, 255, 255, 0.75); }
.filters .lookup { margin-top: 3px; }
.split { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); gap: 18px; align-items: start; }
.list { overflow: hidden; }
.list-head { padding: 9px 18px; font-size: 12px; color: var(--ucp-color-text-alt); background: var(--ucp-color-background); border-bottom: 1px solid var(--ucp-color-divider); }
.row { display: grid; gap: 3px; padding: 12px 18px; border-bottom: 1px solid var(--ucp-color-row-divider); color: var(--ucp-color-text); font-weight: 400; transition: background-color .15s; }
.row:last-child { border-bottom: 0; }
.row:hover { background: var(--ucp-palette-dawn-pink); text-decoration: none; color: var(--ucp-color-text); }
.row.selected { background: var(--ucp-palette-dawn-pink); box-shadow: inset 3px 0 0 var(--ucp-palette-primary-pink); }
.row-main { display: flex; gap: 8px; align-items: baseline; min-width: 0; }
.row-main .num { font-weight: 700; color: var(--ucp-color-interactive); }
.row-main .title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 13px; }
.row-meta .routine { color: var(--ucp-color-text-alt); }
.row-sub { font-size: 12px; color: var(--ucp-color-text-alt); overflow-wrap: anywhere; }
.row-sub code { font-size: 12px; }
.kind { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--ucp-color-text-alt); border: 1px solid var(--ucp-color-divider); border-radius: var(--ucp-border-radius-small); padding: 0 5px; white-space: nowrap; }
.detail { position: sticky; top: 18px; max-height: calc(100vh - 36px); overflow-y: auto; border-radius: var(--ucp-border-radius-large); }
.inline-log { display: none; }
.e2e { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #8a7516; background: #fef5d6; border-radius: var(--ucp-border-radius-small); padding: 0 5px; margin-left: 4px; }
.person { font-weight: 700; color: var(--ucp-color-interactive); background: var(--ucp-palette-dawn-pink); border-radius: var(--ucp-border-radius-small); padding: 0 4px; }
.paused { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #a82547; background: #fbe4eb; border-radius: var(--ucp-border-radius-small); padding: 0 5px; margin-left: 4px; }
.pill[aria-current] .paused, .pill[aria-current] .e2e { background: rgba(255, 255, 255, 0.85); }
.more { display: block; padding: 14px 18px; text-align: center; border-top: 1px solid var(--ucp-color-row-divider); }
.row { scroll-margin-top: 12px; }
.panel { overflow: hidden; }
.panel-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding: 18px 22px; border-bottom: 1px solid var(--ucp-color-divider); }
.panel-head h2 { margin: 0; font-size: 21px; overflow-wrap: anywhere; }
.panel-actions { display: flex; gap: 6px; flex-shrink: 0; }
.panel-facts { padding: 18px 22px; border-bottom: 1px solid var(--ucp-color-divider); }
.panel-log-title { padding: 14px 22px 6px; font-weight: 700; }
table.log { min-width: 560px; }
pre.entry { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-size: 13px; }
.panel-empty { text-align: center; }
.button, button { display: inline-flex; align-items: center; height: 36px; padding: 0 18px; border-radius: var(--ucp-border-radius-medium); font: 700 14px Lato, "Helvetica Neue", Helvetica, Arial, sans-serif; background: var(--ucp-color-interactive); color: #fff; border: 1px solid var(--ucp-color-interactive); cursor: pointer; transition: background-color .15s, box-shadow .15s; }
.button:hover, button:hover { background: var(--ucp-color-default-standalone); color: #fff; text-decoration: none; box-shadow: var(--ucp-shadow-depth-1); }
.button.secondary, button.secondary { background: var(--ucp-color-surface); color: var(--ucp-color-interactive); border-color: var(--ucp-palette-soft-blue); }
.button.secondary:hover, button.secondary:hover { background: var(--ucp-palette-dawn-pink); color: var(--ucp-color-interactive); }
.lookup { display: flex; flex-wrap: wrap; gap: 9px; align-items: center; }
select, input { height: 36px; padding: 0 12px; border: 1px solid var(--ucp-palette-soft-blue); border-radius: var(--ucp-border-radius-medium); background: var(--ucp-color-surface); color: var(--ucp-color-text); font: 14px Lato, "Helvetica Neue", Helvetica, Arial, sans-serif; }
input { width: 180px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.control { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; padding: 24px 30px; border-bottom: 1px solid var(--ucp-color-row-divider); }
.control:last-child { border-bottom: 0; }
.control-name { font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 9px; }
.control p { margin: 4px 0; max-width: 640px; }
.banner { background: #e3f6ec; color: #1e8a50; border-radius: var(--ucp-border-radius-medium); padding: 9px 15px; margin-bottom: 18px; font-weight: 700; font-size: 14px; }
@media (max-width: 1100px) {
  .split { grid-template-columns: 1fr; }
  .detail { display: none; }
  .inline-log { display: block; padding: 0 9px 12px; background: var(--ucp-palette-dawn-pink); border-bottom: 1px solid var(--ucp-color-row-divider); }
  .inline-log .box { box-shadow: none; }
}
@media (max-width: 700px) {
  main { padding: 24px 16px 36px; }
  .top-bar { padding: 0 16px; }
  .top-bar .product span { display: none; }
  .stats { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 9px; }
  .stat { padding: 12px; }
  .box.pad, .control { padding: 18px; }
  .control { flex-direction: column; }
  th, td { padding: 10px 14px; }
  input { width: 100%; }
  /* The log as compact cards: event and mode, then the effect, then when and the routine. */
  table.log { min-width: 0; }
  table.log thead { display: none; }
  table.log tr { display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "event mode" "effect effect" "when routine"; gap: 3px 12px; padding: 12px 16px; border-bottom: 1px solid var(--ucp-color-row-divider); }
  table.log td { display: block; padding: 0; border: 0; overflow-wrap: anywhere; }
  table.log td:nth-child(1) { grid-area: when; font-size: 12px; color: var(--ucp-color-text-alt); }
  table.log td:nth-child(1) .sub { display: none; }
  table.log td:nth-child(2) { grid-area: event; }
  table.log td:nth-child(3) { grid-area: effect; }
  table.log td:nth-child(4) { grid-area: routine; font-size: 12px; color: var(--ucp-color-text-alt); text-align: right; }
  table.log td:nth-child(5) { grid-area: mode; text-align: right; }
  table.log td.empty { grid-column: 1 / -1; }
  .panel-head { flex-direction: column; }
}`;
