(() => {
  "use strict";
  const panelId = "claudemom-cli-skills";
  let panel;
  let generation = 0;

  function element(tag, text, parent) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    parent?.append(node);
    return node;
  }

  function mount() {
    const current = ++generation;
    panel = element("details", undefined, document.body);
    panel.id = panelId;
    const summary = element("summary", "本机 Claude Code Skills", panel);
    element("style", `
      #${panelId} { position:fixed;z-index:80;right:24px;bottom:24px;width:400px;
        max-width:calc(100vw - 48px);box-sizing:border-box;border:1px solid GrayText;
        border-radius:14px;background:Canvas;color:CanvasText;box-shadow:0 8px 30px #0002;
        font:14px/1.5 system-ui,sans-serif; }
      #${panelId} summary { padding:14px 18px;cursor:pointer;font-weight:600; }
      #${panelId} .cm-skills-body { padding:0 18px 14px;max-height:50vh;overflow:auto; }
      #${panelId} p { margin:0 0 10px; }
      #${panelId} .cm-skills-controls { display:flex;gap:8px; }
      #${panelId} input { width:100%;min-width:0;padding:7px;border:1px solid GrayText;
        border-radius:6px;background:Canvas;color:CanvasText; }
      #${panelId} button { padding:6px 10px;border:1px solid GrayText;border-radius:6px;
        background:Canvas;color:CanvasText;cursor:pointer;white-space:nowrap; }
      #${panelId} :focus-visible { outline:2px solid Highlight;outline-offset:3px; }
      #${panelId} ul { margin:12px 0 0;padding-left:20px;overflow-wrap:anywhere; }
      #${panelId} [role=status] { margin-top:8px; }
    `, panel);
    const body = element("div", undefined, panel);
    body.className = "cm-skills-body";
    const source = element("p", "正在读取 CLI 配置目录…", body);
    element("p", "个人 Skills 目录，只读展示；插件中的 Skills 由原页面列出。", body);
    const controls = element("div", undefined, body);
    controls.className = "cm-skills-controls";
    const search = element("input", undefined, controls);
    search.type = "search";
    search.placeholder = "按目录名搜索";
    search.setAttribute("aria-label", "搜索本机 Claude Code Skills");
    const refresh = element("button", "刷新", controls);
    refresh.type = "button";
    refresh.setAttribute("aria-label", "刷新本机 Claude Code Skills");
    const status = element("p", "", body);
    status.setAttribute("role", "status");
    const list = element("ul", undefined, body);
    list.setAttribute("aria-label", "本机 Claude Code Skills 目录列表");
    let skills = [];
    let request = 0;
    let available = false;
    let error = "";

    function render() {
      const filtered = skills.filter((skill) => skill.directoryName.toLocaleLowerCase()
        .includes(search.value.trim().toLocaleLowerCase()));
      list.replaceChildren();
      for (const skill of filtered) element("li", skill.directoryName, list);
      summary.textContent = `本机 Claude Code Skills（${skills.length}）`;
      status.textContent = error || (!available ? "目录不可用。" : skills.length === 0
        ? "此目录没有包含 SKILL.md 的个人 Skill。" : `显示 ${filtered.length} / ${skills.length} 个目录`);
    }

    async function load() {
      const revision = ++request;
      refresh.disabled = true;
      status.textContent = "正在刷新…";
      try {
        const response = await fetch("/__claudemom/cli-skills", { cache: "no-store", credentials: "same-origin" });
        if (!response.ok) throw new Error("unavailable");
        const result = await response.json();
        if (current !== generation || revision !== request) return;
        skills = Array.isArray(result.skills) ? result.skills
          .filter((skill) => typeof skill.directoryName === "string") : [];
        available = result.available === true;
        source.textContent = `来源：${result.directoryLabel || "CLI 配置目录"}`;
        error = available ? "" : "无法读取 CLI Skills 目录，请检查目录权限后刷新。";
      } catch {
        if (current !== generation || revision !== request) return;
        available = false;
        skills = [];
        error = "读取失败，请确认 ClaudeMom 正在运行后刷新。";
      } finally {
        if (current === generation && revision === request) {
          refresh.disabled = false;
          render();
        }
      }
    }

    search.addEventListener("input", render);
    refresh.addEventListener("click", load);
    void load();
  }

  function update() {
    const visible = /^\/customize\/skills(?:\/yours)?\/?$/.test(location.pathname);
    if (visible && !panel) mount();
    if (!visible && panel) {
      ++generation;
      panel.remove();
      panel = undefined;
    }
  }

  function start() {
    update();
    // The official router does not emit popstate for pushState navigation.
    // Observe route-driven DOM changes without replacing its history methods.
    new MutationObserver(update).observe(document.body, { childList: true, subtree: true });
    addEventListener("popstate", update);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
