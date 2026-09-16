// コンテンツスクリプト: 参照トレース
// ルックアップ・関連レコードの参照関係を再帰的に辿り、表形式とnode/edgeグラフで表示する。

import type {
  AppEdge,
  AppNode,
  FetchStatus,
  FieldProperty,
  FieldRef,
  TraceGraph,
} from "./types";

(() => {
  console.log("[Kintone Dev Tools] fieldTrace.js (content script) loaded.");

  const OVERLAY_ID = "kintone-dev-tools-field-trace-overlay";
  const DIALOG_ID = "kintone-dev-tools-field-trace-dialog";
  const MAX_APPS = 60; // 暴走防止のアプリ数上限

  type KintoneApi = ((
    url: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    params: unknown,
  ) => Promise<unknown>) & {
    url: (path: string, isGuestSpace: boolean) => string;
  };

  const getApi = (): KintoneApi | null => {
    if (typeof kintone === "undefined" || !kintone) return null;
    const api = (kintone as unknown as { api?: KintoneApi }).api;
    return typeof api === "function" ? api : null;
  };

  // ---- API 呼び出し --------------------------------------------------------

  const fetchFields = async (
    api: KintoneApi,
    appId: string,
  ): Promise<{ [code: string]: FieldProperty }> => {
    const res = (await api(api.url("/k/v1/app/form/fields.json", true), "GET", {
      app: appId,
      lang: "default",
    })) as { properties?: { [code: string]: FieldProperty } };
    return res.properties ?? {};
  };

  const fetchAppMeta = async (
    api: KintoneApi,
    appId: string,
  ): Promise<{ name: string; spaceId?: string }> => {
    try {
      const res = (await api(api.url("/k/v1/app.json", true), "GET", {
        id: appId,
      })) as Record<string, unknown>;
      return {
        name:
          typeof res.name === "string" && res.name ? res.name : "（名称不明）",
        spaceId: res.spaceId != null ? String(res.spaceId) : undefined,
      };
    } catch {
      return { name: "（名称不明）" };
    }
  };

  // 指定スペース内のアプリ一覧を取得（appId/name のみ。上限までページング）
  const SPACE_SCAN_LIMIT = 100; // 走査する同スペースアプリ数の上限
  const listSpaceApps = async (
    api: KintoneApi,
    spaceId: string,
  ): Promise<{ apps: { appId: string; name: string }[]; limited: boolean }> => {
    const apps: { appId: string; name: string }[] = [];
    let offset = 0;
    const pageSize = 100;
    let limited = false;
    while (true) {
      const res = (await api(api.url("/k/v1/apps.json", true), "GET", {
        spaceIds: [spaceId],
        limit: pageSize,
        offset,
      })) as { apps?: { appId: string | number; name: string }[] };
      const batch = res.apps ?? [];
      for (const a of batch) {
        apps.push({ appId: String(a.appId), name: a.name });
      }
      if (batch.length < pageSize) break;
      offset += pageSize;
      if (apps.length >= SPACE_SCAN_LIMIT) {
        limited = true;
        break;
      }
    }
    return { apps: apps.slice(0, SPACE_SCAN_LIMIT), limited };
  };

  // エラーが権限起因（403）かどうかを best-effort で判定
  const classifyError = (error: unknown): FetchStatus => {
    const e = error as Record<string, unknown> | undefined;
    const code = typeof e?.code === "string" ? e.code : "";
    const status = e?.status;
    const message = typeof e?.message === "string" ? e.message : "";
    if (status === 403) return "forbidden";
    if (/NO0|IL26|permission|権限/i.test(`${code} ${message}`)) return "forbidden";
    return "error";
  };

  // ---- 参照抽出 ------------------------------------------------------------

  const relatedAppId = (
    prop: FieldProperty,
    key: "lookup" | "referenceTable",
  ): string => {
    const cfg = prop[key] as
      | { relatedApp?: { app?: string | number } }
      | undefined;
    const app = cfg?.relatedApp?.app;
    return app != null ? String(app) : "";
  };

  // 1アプリ分の properties から参照フィールド（FieldRef）を抽出する。
  // relatedAppName は後段（走査後）に埋める。tableCode はサブテーブル内フィールド用。
  const extractRefs = (
    appId: string,
    appName: string,
    properties: { [code: string]: FieldProperty },
    tableCode?: string,
  ): FieldRef[] => {
    const rows: FieldRef[] = [];
    for (const code of Object.keys(properties)) {
      const prop = properties[code];
      if (!prop || typeof prop !== "object") continue;

      // サブテーブルは内包フィールドを再帰的に走査
      if (prop.type === "SUBTABLE" && prop.fields) {
        rows.push(...extractRefs(appId, appName, prop.fields, prop.code));
        continue;
      }

      // ルックアップ（型は問わず lookup プロパティの有無で判定）
      if (prop.lookup) {
        const relId = relatedAppId(prop, "lookup");
        rows.push({
          appId,
          appName,
          tableCode,
          fieldCode: prop.code,
          fieldLabel: prop.label,
          baseType: prop.type,
          kind: "LOOKUP",
          relatedAppId: relId,
          relatedAppName: "",
          keyField: prop.lookup.relatedKeyField ?? "",
          mappings: (prop.lookup.fieldMappings ?? []).map((m) => ({
            field: m.field,
            relatedField: m.relatedField,
          })),
        });
        continue;
      }

      // 関連レコード一覧
      if (prop.type === "REFERENCE_TABLE" && prop.referenceTable) {
        const relId = relatedAppId(prop, "referenceTable");
        const cond = prop.referenceTable.condition;
        rows.push({
          appId,
          appName,
          tableCode,
          fieldCode: prop.code,
          fieldLabel: prop.label,
          baseType: "REFERENCE_TABLE",
          kind: "REFERENCE_TABLE",
          relatedAppId: relId,
          relatedAppName: "",
          keyField: cond?.relatedField ?? "",
          mappings: cond ? [{ field: cond.field, relatedField: cond.relatedField }] : [],
        });
      }
    }
    return rows;
  };

  // ---- 再帰トラバース（BFS） ----------------------------------------------

  const buildGraph = async (
    api: KintoneApi,
    startAppId: string,
  ): Promise<TraceGraph> => {
    const nodes = new Map<string, AppNode>();
    const rows: FieldRef[] = [];
    const edges: AppEdge[] = [];
    const visited = new Set<string>();
    const queue: string[] = [startAppId];
    let truncated = false;
    let startSpaceId: string | undefined;

    while (queue.length > 0) {
      const appId = queue.shift() as string;
      if (visited.has(appId)) continue;
      visited.add(appId);

      if (nodes.size >= MAX_APPS) {
        truncated = true;
        break;
      }

      const meta = await fetchAppMeta(api, appId);
      const appName = meta.name;
      if (appId === startAppId) startSpaceId = meta.spaceId;
      let status: FetchStatus = "ok";
      let properties: { [code: string]: FieldProperty } = {};
      try {
        properties = await fetchFields(api, appId);
      } catch (err) {
        status = classifyError(err);
        console.warn(
          `[Kintone Dev Tools] fields.json 取得失敗 (app=${appId}):`,
          err,
        );
      }
      nodes.set(appId, { appId, appName, fetchStatus: status });

      if (status !== "ok") continue;

      const appRows = extractRefs(appId, appName, properties);
      for (const row of appRows) {
        rows.push(row);
        if (!row.relatedAppId) continue;
        edges.push({
          fromAppId: appId,
          toAppId: row.relatedAppId,
          fieldCode: row.fieldCode,
          kind: row.kind,
        });
        if (!visited.has(row.relatedAppId)) queue.push(row.relatedAppId);
      }
    }

    // ---- 被参照スキャン（起点アプリと同じスペース内限定） ----
    // 同スペースの各アプリの参照先が、グラフ内のノードを指していれば
    // 「被参照」としてそのアプリ（と該当エッジ）をグラフへ取り込む。
    let spaceScanCount: number | undefined;
    let spaceScanLimited = false;
    if (startSpaceId != null && !truncated) {
      try {
        const { apps: spaceApps, limited } = await listSpaceApps(
          api,
          startSpaceId,
        );
        spaceScanLimited = limited;
        // ノード未登録の同スペースアプリについて参照を先読みキャッシュ
        const spaceRefs = new Map<string, FieldRef[]>();
        const spaceName = new Map<string, string>();
        for (const sa of spaceApps) {
          spaceName.set(sa.appId, sa.name);
          if (nodes.has(sa.appId)) continue;
          try {
            const props = await fetchFields(api, sa.appId);
            spaceRefs.set(sa.appId, extractRefs(sa.appId, sa.name, props));
          } catch {
            // 読めないアプリは被参照を判定できないためスキップ
            spaceRefs.set(sa.appId, []);
          }
        }
        spaceScanCount = spaceApps.length;

        // グラフ内ノードを参照するアプリをノードとして取り込む（連鎖も検出）
        let changed = true;
        while (changed) {
          changed = false;
          for (const sa of spaceApps) {
            if (nodes.has(sa.appId)) continue;
            const refs = spaceRefs.get(sa.appId) ?? [];
            const hit = refs.some(
              (r) => r.relatedAppId && nodes.has(r.relatedAppId),
            );
            if (!hit) continue;
            if (nodes.size >= MAX_APPS) {
              truncated = true;
              changed = false;
              break;
            }
            nodes.set(sa.appId, {
              appId: sa.appId,
              appName: sa.name,
              fetchStatus: "ok",
              incoming: true,
            });
            changed = true;
          }
        }

        // 取り込んだ被参照アプリの、グラフ内ノード向けエッジ/行を追加
        for (const [appId, refs] of spaceRefs) {
          if (!nodes.get(appId)?.incoming) continue;
          for (const r of refs) {
            if (!r.relatedAppId || !nodes.has(r.relatedAppId)) continue;
            rows.push(r);
            edges.push({
              fromAppId: appId,
              toAppId: r.relatedAppId,
              fieldCode: r.fieldCode,
              kind: r.kind,
            });
          }
        }
      } catch (err) {
        console.warn("[Kintone Dev Tools] 被参照スキャン失敗:", err);
      }
    }

    // relatedAppName を解決（ノードに存在すれば名前を埋める）
    for (const row of rows) {
      const node = nodes.get(row.relatedAppId);
      row.relatedAppName = node ? node.appName : "";
    }

    const incomingCount = [...nodes.values()].filter(
      (nd) => nd.incoming,
    ).length;

    return {
      nodes: [...nodes.values()],
      edges,
      rows,
      truncated,
      startSpaceId,
      spaceScanCount,
      spaceScanLimited,
      incomingCount,
    };
  };

  // ---- ユーティリティ ------------------------------------------------------

  const copyTextToClipboard = async (text: string): Promise<boolean> => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // フォールバックへ
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  };

  const escapeTsvCell = (value: string): string =>
    value.split("\t").join(" ").split("\r\n").join("\n").split("\r").join("\n");

  const toTsv = (rowsData: string[][]): string =>
    rowsData.map((r) => r.map(escapeTsvCell).join("\t")).join("\n");

  const kindLabel = (kind: string): string =>
    kind === "LOOKUP" ? "ルックアップ" : "関連レコード";

  const kindEmoji = (kind: string): string =>
    kind === "LOOKUP" ? "📥" : "👀";

  const esc = (s: string): string =>
    s
      .split("&").join("&amp;")
      .split("<").join("&lt;")
      .split(">").join("&gt;");

  // ---- 表形式ビュー --------------------------------------------------------

  const TABLE_HEADERS = [
    "アプリ",
    "テーブル",
    "フィールドコード",
    "ラベル",
    "種別",
    "参照先アプリ",
    "キーフィールド",
    "マッピング",
  ];

  const rowToCells = (r: FieldRef): string[] => [
    `${r.appName} (${r.appId})`,
    r.tableCode ?? "",
    r.fieldCode,
    r.fieldLabel,
    kindLabel(r.kind),
    r.relatedAppId ? `${r.relatedAppName || "（未取得）"} (${r.relatedAppId})` : "",
    r.keyField,
    r.mappings.map((m) => `${m.field} ← ${m.relatedField}`).join(" / "),
  ];

  const renderTableView = (graph: TraceGraph): HTMLElement => {
    const container = document.createElement("div");

    if (graph.rows.length === 0) {
      const empty = document.createElement("p");
      empty.textContent =
        "ルックアップ・関連レコードの参照フィールドは見つかりませんでした。";
      empty.style.padding = "16px";
      container.appendChild(empty);
      return container;
    }

    const scroll = document.createElement("div");
    scroll.style.cssText = "overflow: auto; max-height: 60vh;";

    const table = document.createElement("table");
    table.style.cssText =
      "border-collapse: collapse; width: 100%; font-size: 0.85em;";

    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    for (const h of TABLE_HEADERS) {
      const th = document.createElement("th");
      th.textContent = h;
      th.style.cssText =
        "border: 1px solid #ddd; padding: 6px 8px; background: #1e88e5; color: #fff; position: sticky; top: 0; white-space: nowrap; text-align: left;";
      htr.appendChild(th);
    }
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    graph.rows.forEach((r, i) => {
      const tr = document.createElement("tr");
      tr.style.background = i % 2 === 0 ? "#fff" : "#f7f9fc";
      for (const cell of rowToCells(r)) {
        const td = document.createElement("td");
        td.textContent = cell;
        td.style.cssText =
          "border: 1px solid #ddd; padding: 6px 8px; vertical-align: top; word-break: break-all;";
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    scroll.appendChild(table);
    container.appendChild(scroll);

    // コピー用ボタン
    const btnBar = document.createElement("div");
    btnBar.style.cssText = "display: flex; gap: 8px; margin-top: 10px;";

    const tsvBtn = makeButton("表をコピー(TSV)", "#3498db");
    tsvBtn.onclick = async () => {
      const tsv = toTsv([TABLE_HEADERS, ...graph.rows.map(rowToCells)]);
      const ok = await copyTextToClipboard(tsv);
      tsvBtn.textContent = ok ? "コピーしました" : "コピー失敗";
      setTimeout(() => {
        tsvBtn.textContent = "表をコピー(TSV)";
      }, 1500);
    };

    const jsonBtn = makeButton("JSONコピー", "#3498db");
    jsonBtn.onclick = async () => {
      const ok = await copyTextToClipboard(JSON.stringify(graph.rows, null, 2));
      jsonBtn.textContent = ok ? "コピーしました" : "コピー失敗";
      setTimeout(() => {
        jsonBtn.textContent = "JSONコピー";
      }, 1500);
    };

    btnBar.appendChild(tsvBtn);
    btnBar.appendChild(jsonBtn);
    container.appendChild(btnBar);

    return container;
  };

  // ---- グラフビュー（app単位 node/edge） -----------------------------------

  const nodeFill = (status: FetchStatus): string =>
    status === "ok" ? "#e3f2fd" : "#eeeeee";
  const nodeStroke = (status: FetchStatus): string =>
    status === "ok" ? "#1e88e5" : "#9e9e9e";

  // (from,to) 単位でエッジを集約し、フィールド名ラベルをまとめる
  // 種別の並び順（ルックアップ→関連レコード）
  const kindRank = (kind: string): number => (kind === "LOOKUP" ? 0 : 1);

  // (from,to) 単位でエッジを集約し、ラベルをソート済みの配列で返す。
  // 並び順: ルックアップ→関連レコード→フィールドコードの文字列順。
  const aggregateEdges = (
    edges: AppEdge[],
    useEmoji = false,
  ): { from: string; to: string; labels: string[] }[] => {
    const map = new Map<
      string,
      {
        from: string;
        to: string;
        items: { kind: string; fieldCode: string }[];
        seen: Set<string>;
      }
    >();
    for (const e of edges) {
      const key = `${e.fromAppId}->${e.toAppId}`;
      let cur = map.get(key);
      if (!cur) {
        cur = { from: e.fromAppId, to: e.toAppId, items: [], seen: new Set() };
        map.set(key, cur);
      }
      const itemKey = `${e.kind}:${e.fieldCode}`;
      if (!cur.seen.has(itemKey)) {
        cur.seen.add(itemKey);
        cur.items.push({ kind: e.kind, fieldCode: e.fieldCode });
      }
    }
    return [...map.values()].map((v) => {
      v.items.sort(
        (a, b) =>
          kindRank(a.kind) - kindRank(b.kind) ||
          a.fieldCode.localeCompare(b.fieldCode),
      );
      const labels = v.items.map((it) =>
        useEmoji
          ? `${kindEmoji(it.kind)}${it.fieldCode}`
          : `${it.fieldCode}(${kindLabel(it.kind)})`,
      );
      return { from: v.from, to: v.to, labels };
    });
  };

  const SVG_NS = "http://www.w3.org/2000/svg";
  const svgEl = <K extends keyof SVGElementTagNameMap>(
    tag: K,
    attrs: Record<string, string | number>,
  ): SVGElementTagNameMap[K] => {
    const el = document.createElementNS(SVG_NS, tag);
    for (const k of Object.keys(attrs)) el.setAttribute(k, String(attrs[k]));
    return el;
  };

  // node/edge グラフを DOM で構築し、ノードをドラッグ可能にした SVG 要素を返す
  const buildSvgElement = (
    graph: TraceGraph,
    startAppId: string,
  ): {
    svg: SVGSVGElement;
    positions: Map<string, { x: number; y: number }>;
    layout: Map<string, { short: string; w: number; h: number }>;
    setKindVisible: (kind: string, visible: boolean) => void;
  } => {
    const width = 760;
    const height = 520;
    const cx = width / 2;
    const cy = height / 2;
    const nodeList = graph.nodes;
    const n = nodeList.length;
    const radius = Math.max(60, Math.min(width, height) / 2 - 110);

    // 初期配置（円環レイアウト）。pos はドラッグで更新される可変状態。
    const pos = new Map<string, { x: number; y: number }>();
    nodeList.forEach((node, i) => {
      if (n === 1) {
        pos.set(node.appId, { x: cx, y: cy });
      } else {
        const angle = (2 * Math.PI * i) / n - Math.PI / 2;
        pos.set(node.appId, {
          x: cx + radius * Math.cos(angle),
          y: cy + radius * Math.sin(angle),
        });
      }
    });

    const svg = svgEl("svg", {
      width,
      height,
      style: "background:#fafafa;border:1px solid #e0e0e0;touch-action:none;",
    });
    const defs = svgEl("defs", {});
    const marker = svgEl("marker", {
      id: "ftArrow",
      markerWidth: 10,
      markerHeight: 10,
      refX: 9,
      refY: 3,
      orient: "auto",
      markerUnits: "strokeWidth",
    });
    marker.appendChild(svgEl("path", { d: "M0,0 L9,3 L0,6 Z", fill: "#607d8b" }));
    defs.appendChild(marker);
    const filter = svgEl("filter", {
      id: "ftGlow",
      x: "-40%",
      y: "-40%",
      width: "180%",
      height: "180%",
    });
    filter.appendChild(
      svgEl("feDropShadow", {
        dx: 0,
        dy: 0,
        stdDeviation: 3,
        "flood-color": "#f9a825",
        "flood-opacity": "0.9",
      }),
    );
    defs.appendChild(filter);
    svg.appendChild(defs);

    // エッジ用グループ（ノードより背面に置く）
    const edgeLayer = svgEl("g", {});
    svg.appendChild(edgeLayer);
    const nodeLayer = svgEl("g", {});
    svg.appendChild(nodeLayer);

    // ノードの表示寸法を先に計算（自己ループのエッジ描画でも参照する）
    const nodeLayout = new Map<
      string,
      { short: string; w: number; h: number }
    >();
    for (const node of nodeList) {
      const isStart = node.appId === startAppId;
      const short =
        node.appName.length > 18
          ? `${node.appName.slice(0, 17)}…`
          : node.appName;
      const w = Math.max(90, short.length * 9 + 16) + (isStart ? 12 : 0);
      const h = isStart ? 38 : 32;
      nodeLayout.set(node.appId, { short, w, h });
    }

    // 種別ごとの表示ON/OFF状態
    const show: Record<string, boolean> = {
      LOOKUP: true,
      REFERENCE_TABLE: true,
    };

    // エッジ要素を作り、pos から座標を再計算できるよう参照を保持。
    // ラベルは種別付きで保持し、表示状態に応じて再構築する。
    const truncLine = (s: string): string =>
      s.length > 24 ? `${s.slice(0, 23)}…` : s;

    // (from,to) 単位に集約し、種別付き項目を保持
    const pairMap = new Map<
      string,
      {
        from: string;
        to: string;
        items: { kind: string; fieldCode: string }[];
        seen: Set<string>;
      }
    >();
    for (const e of graph.edges) {
      if (!pos.has(e.fromAppId) || !pos.has(e.toAppId)) continue;
      const key = `${e.fromAppId}->${e.toAppId}`;
      let cur = pairMap.get(key);
      if (!cur) {
        cur = { from: e.fromAppId, to: e.toAppId, items: [], seen: new Set() };
        pairMap.set(key, cur);
      }
      const ik = `${e.kind}:${e.fieldCode}`;
      if (!cur.seen.has(ik)) {
        cur.seen.add(ik);
        cur.items.push({ kind: e.kind, fieldCode: e.fieldCode });
      }
    }

    const edgeRecords: {
      from: string;
      to: string;
      el: SVGLineElement | SVGPathElement;
      text: SVGTextElement;
      items: { kind: string; label: string }[];
      tspans: SVGTSpanElement[];
      self: boolean;
    }[] = [];
    for (const grp of pairMap.values()) {
      const self = grp.from === grp.to;
      const el = self
        ? svgEl("path", {
            fill: "none",
            stroke: "#607d8b",
            "stroke-width": 1.5,
            "marker-end": "url(#ftArrow)",
          })
        : svgEl("line", {
            stroke: "#607d8b",
            "stroke-width": 1.5,
            "marker-end": "url(#ftArrow)",
          });
      const text = svgEl("text", {
        "font-size": 10,
        fill: "#455a64",
        "text-anchor": self ? "start" : "middle",
      });
      // 種別（ルックアップ→関連レコード）→フィールドコード順にソート
      grp.items.sort(
        (a, b) =>
          kindRank(a.kind) - kindRank(b.kind) ||
          a.fieldCode.localeCompare(b.fieldCode),
      );
      const items = grp.items.map((it) => ({
        kind: it.kind,
        label: `${kindEmoji(it.kind)}${it.fieldCode}`,
      }));
      edgeLayer.appendChild(el);
      edgeLayer.appendChild(text);
      edgeRecords.push({
        from: grp.from,
        to: grp.to,
        el,
        text,
        items,
        tspans: [],
        self,
      });
    }

    // 表示状態に応じてラベル(tspan)を再構築し、エッジの表示/非表示も切替
    const rebuildEdgeLabels = (): void => {
      for (const ed of edgeRecords) {
        while (ed.text.firstChild) ed.text.removeChild(ed.text.firstChild);
        const vis = ed.items.filter((it) => show[it.kind]);
        ed.tspans = vis.map((it, i) => {
          const t = svgEl("tspan", { x: 0, dy: i === 0 ? "0" : "1.15em" });
          t.textContent = truncLine(it.label);
          ed.text.appendChild(t);
          return t;
        });
        const any = vis.length > 0;
        ed.el.style.display = any ? "" : "none";
        ed.text.style.display = any ? "" : "none";
      }
    };

    // 複数行ラベルを配置する（全 tspan の x を揃え、先頭行の y を設定）
    const LINE_H = 11.5;
    const placeLabel = (
      ed: (typeof edgeRecords)[number],
      x: number,
      topY: number,
    ): void => {
      ed.text.setAttribute("x", x.toFixed(1));
      ed.text.setAttribute("y", topY.toFixed(1));
      for (const t of ed.tspans) t.setAttribute("x", x.toFixed(1));
    };

    // pos に基づき全エッジの端点/ラベル位置を再計算
    const redrawEdges = (): void => {
      for (const ed of edgeRecords) {
        const a = pos.get(ed.from);
        if (!a) continue;
        const n = ed.tspans.length;

        // 自己参照はノード右側にループを描き、ラベルもノード外へ出す
        if (ed.self) {
          const w = nodeLayout.get(ed.from)?.w ?? 90;
          const rx = a.x + w / 2; // ノード右端
          const bulge = 42;
          const d = `M ${rx.toFixed(1)} ${(a.y - 8).toFixed(1)} C ${(rx + bulge).toFixed(1)} ${(a.y - 26).toFixed(1)}, ${(rx + bulge).toFixed(1)} ${(a.y + 26).toFixed(1)}, ${rx.toFixed(1)} ${(a.y + 8).toFixed(1)}`;
          ed.el.setAttribute("d", d);
          // ラベル群を縦方向にほぼ中央寄せ
          placeLabel(ed, rx + bulge + 6, a.y + 3 - ((n - 1) * LINE_H) / 2);
          continue;
        }

        const b = pos.get(ed.to);
        if (!b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        const pad = 46;
        const x1 = a.x + ux * pad;
        const y1 = a.y + uy * pad;
        const x2 = b.x - ux * pad;
        const y2 = b.y - uy * pad;
        ed.el.setAttribute("x1", x1.toFixed(1));
        ed.el.setAttribute("y1", y1.toFixed(1));
        ed.el.setAttribute("x2", x2.toFixed(1));
        ed.el.setAttribute("y2", y2.toFixed(1));
        // ラベル群は線の中点の上側に積む（最終行が線の直上）
        placeLabel(ed, (x1 + x2) / 2, (y1 + y2) / 2 - 4 - (n - 1) * LINE_H);
      }
    };
    rebuildEdgeLabels();
    redrawEdges();

    // 種別の表示ON/OFFを外部から切り替える
    const setKindVisible = (kind: string, visible: boolean): void => {
      show[kind] = visible;
      rebuildEdgeLabels();
      redrawEdges();
    };

    // ノード（起点アプリは強調するため後ろ＝前面に描画）
    const orderedNodes = [
      ...nodeList.filter((nd) => nd.appId !== startAppId),
      ...nodeList.filter((nd) => nd.appId === startAppId),
    ];
    for (const node of orderedNodes) {
      const p = pos.get(node.appId);
      if (!p) continue;
      const isStart = node.appId === startAppId;
      // アプリIDはタブに表示するため、ノード本体はアプリ名のみを表示
      const dim = nodeLayout.get(node.appId);
      const short = dim?.short ?? node.appName;
      const w = dim?.w ?? 90;
      const h = dim?.h ?? 32;

      // ノードは g(translate) にまとめ、子要素はローカル座標(原点中心)で配置
      const g = svgEl("g", {
        transform: `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`,
        style: "cursor:grab;",
      });
      // 被参照ノード（incoming）は緑系で区別
      const isIncoming = !!node.incoming;
      const fillColor = isStart
        ? "#fff8e1"
        : isIncoming
          ? "#e8f5e9"
          : nodeFill(node.fetchStatus);
      const strokeColor = isStart
        ? "#f9a825"
        : isIncoming
          ? "#43a047"
          : nodeStroke(node.fetchStatus);
      const rectAttrs: Record<string, string | number> = {
        x: -w / 2,
        y: -h / 2,
        width: w,
        height: h,
        rx: 6,
        fill: fillColor,
        stroke: strokeColor,
        "stroke-width": isStart ? 3 : 1.5,
      };
      if (isStart) rectAttrs.filter = "url(#ftGlow)";
      g.appendChild(svgEl("rect", rectAttrs));

      // すべてのノードにアプリIDのタブを付与
      const idText = String(node.appId);
      const tabW = Math.max(30, idText.length * 7 + 12);
      const tabColor = strokeColor;
      g.appendChild(
        svgEl("rect", {
          x: -w / 2,
          y: -h / 2 - 15,
          width: tabW,
          height: 16,
          rx: 8,
          fill: tabColor,
        }),
      );
      const tab = svgEl("text", {
        x: -w / 2 + tabW / 2,
        y: -h / 2 - 3,
        "font-size": 10,
        fill: "#fff",
        "text-anchor": "middle",
        "font-weight": "bold",
      });
      tab.textContent = idText;
      g.appendChild(tab);

      const nameText = svgEl("text", {
        x: 0,
        y: 4,
        "font-size": 11,
        fill: "#263238",
        "text-anchor": "middle",
        "font-weight": isStart ? "bold" : "normal",
      });
      nameText.textContent = short;
      g.appendChild(nameText);

      if (node.fetchStatus !== "ok") {
        const st = svgEl("text", {
          x: 0,
          y: h / 2 + 12,
          "font-size": 9,
          fill: "#c62828",
          "text-anchor": "middle",
        });
        st.textContent =
          node.fetchStatus === "forbidden" ? "権限なし" : "取得不可";
        g.appendChild(st);
      }

      // ドラッグ処理（pointer イベント + delta 方式。スケール無しなので px=SVG単位）
      const appId = node.appId;
      let dragging = false;
      let lastX = 0;
      let lastY = 0;
      g.addEventListener("pointerdown", (ev: PointerEvent) => {
        dragging = true;
        lastX = ev.clientX;
        lastY = ev.clientY;
        g.style.cursor = "grabbing";
        g.setPointerCapture(ev.pointerId);
        ev.preventDefault();
      });
      g.addEventListener("pointermove", (ev: PointerEvent) => {
        if (!dragging) return;
        const cur = pos.get(appId);
        if (!cur) return;
        cur.x += ev.clientX - lastX;
        cur.y += ev.clientY - lastY;
        lastX = ev.clientX;
        lastY = ev.clientY;
        g.setAttribute(
          "transform",
          `translate(${cur.x.toFixed(1)},${cur.y.toFixed(1)})`,
        );
        redrawEdges();
      });
      const endDrag = (ev: PointerEvent) => {
        if (!dragging) return;
        dragging = false;
        g.style.cursor = "grab";
        try {
          g.releasePointerCapture(ev.pointerId);
        } catch {
          // capture 未設定時は無視
        }
      };
      g.addEventListener("pointerup", endDrag);
      g.addEventListener("pointercancel", endDrag);

      nodeLayer.appendChild(g);
    }

    return { svg, positions: pos, layout: nodeLayout, setKindVisible };
  };

  // 現在のグラフ配置を draw.io (mxGraph) XML に変換する
  const xmlEsc = (s: string): string =>
    s
      .split("&").join("&amp;")
      .split("<").join("&lt;")
      .split(">").join("&gt;")
      .split('"').join("&quot;")
      .split("\n").join("&#10;");

  const toDrawioXml = (
    graph: TraceGraph,
    positions: Map<string, { x: number; y: number }>,
    layout: Map<string, { short: string; w: number; h: number }>,
    startAppId: string,
  ): string => {
    const cells: string[] = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];

    for (const node of graph.nodes) {
      const p = positions.get(node.appId) ?? { x: 400, y: 260 };
      const dim = layout.get(node.appId);
      const w = dim?.w ?? 120;
      const h = dim?.h ?? 40;
      const isStart = node.appId === startAppId;
      let fill = "#e3f2fd";
      let stroke = "#1e88e5";
      if (isStart) {
        fill = "#fff8e1";
        stroke = "#f9a825";
      } else if (node.incoming) {
        fill = "#e8f5e9";
        stroke = "#43a047";
      } else if (node.fetchStatus !== "ok") {
        fill = "#eeeeee";
        stroke = "#9e9e9e";
      }
      const style = `rounded=1;whiteSpace=wrap;html=1;fillColor=${fill};strokeColor=${stroke};`;
      const value = xmlEsc(`${node.appName} (${node.appId})`);
      const x = (p.x - w / 2).toFixed(1);
      const y = (p.y - h / 2).toFixed(1);
      cells.push(
        `<mxCell id="n${node.appId}" value="${value}" style="${style}" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/></mxCell>`,
      );
    }

    let i = 0;
    for (const e of aggregateEdges(graph.edges, true)) {
      const value = xmlEsc(e.labels.join("\n"));
      // エッジは直線（edgeStyle=none で経由点なしの直線ルーティング）
      const style =
        "edgeStyle=none;rounded=0;curved=0;html=1;endArrow=classic;fontSize=10;";
      cells.push(
        `<mxCell id="e${i}" value="${value}" style="${style}" edge="1" parent="1" source="n${e.from}" target="n${e.to}"><mxGeometry relative="1" as="geometry"/></mxCell>`,
      );
      i++;
    }

    return `<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">
  <root>
    ${cells.join("\n    ")}
  </root>
</mxGraphModel>`;
  };

  const toMermaid = (graph: TraceGraph): string => {
    const lines: string[] = ["graph LR"];
    for (const node of graph.nodes) {
      const label = `${node.appName} (${node.appId})`.split('"').join("'");
      lines.push(`  app${node.appId}["${label}"]`);
    }
    for (const e of aggregateEdges(graph.edges)) {
      const label = e.labels.join("<br/>").split('"').join("'");
      lines.push(`  app${e.from} -->|"${label}"| app${e.to}`);
    }
    return lines.join("\n");
  };

  const toDot = (graph: TraceGraph): string => {
    const lines: string[] = ["digraph FieldTrace {", "  rankdir=LR;"];
    for (const node of graph.nodes) {
      const label = `${node.appName} (${node.appId})`.split('"').join("'");
      lines.push(`  "${node.appId}" [label="${label}"];`);
    }
    for (const e of aggregateEdges(graph.edges)) {
      const label = e.labels.join("\\n").split('"').join("'");
      lines.push(`  "${e.from}" -> "${e.to}" [label="${label}"];`);
    }
    lines.push("}");
    return lines.join("\n");
  };

  // SVG要素を PNG Blob にラスタライズする（背景は白で塗る）
  const svgToPngBlob = (svg: SVGSVGElement): Promise<Blob> =>
    new Promise((resolve, reject) => {
      const w = Number(svg.getAttribute("width")) || 760;
      const h = Number(svg.getAttribute("height")) || 520;
      const clone = svg.cloneNode(true) as SVGSVGElement;
      clone.setAttribute("xmlns", SVG_NS);
      const xml = new XMLSerializer().serializeToString(clone);
      const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
      const img = new Image();
      const scale = 2; // 高解像度化
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = w * scale;
        canvas.height = h * scale;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("canvas context を取得できませんでした"));
          return;
        }
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.scale(scale, scale);
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error("PNG への変換に失敗しました"));
        }, "image/png");
      };
      img.onerror = () => reject(new Error("SVG の画像化に失敗しました"));
      img.src = src;
    });

  // グラフSVGを画像としてクリップボードへコピー
  const copyGraphImage = async (svg: SVGSVGElement): Promise<boolean> => {
    try {
      if (
        typeof ClipboardItem === "undefined" ||
        !navigator.clipboard?.write
      ) {
        return false;
      }
      const blob = await svgToPngBlob(svg);
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      return true;
    } catch (err) {
      console.error("[Kintone Dev Tools] 画像コピー失敗:", err);
      return false;
    }
  };

  const renderGraphView = (
    graph: TraceGraph,
    startAppId: string,
  ): HTMLElement => {
    const container = document.createElement("div");

    if (graph.nodes.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "表示できるアプリがありません。";
      container.appendChild(empty);
      return container;
    }

    const hint = document.createElement("p");
    hint.textContent =
      "※ ノードをドラッグして配置を調整できます。📥=ルックアップ / 👀=関連レコード。黄枠=起点 / 緑枠=被参照(同スペース)";
    hint.style.cssText = "margin: 0 0 6px 0; font-size: 0.75em; color: #888;";
    container.appendChild(hint);

    const { svg, positions, layout, setKindVisible } = buildSvgElement(
      graph,
      startAppId,
    );

    // 種別ごとのエッジ表示ON/OFF（コピー系エクスポートにも反映する）
    const visibleKinds: Record<string, boolean> = {
      LOOKUP: true,
      REFERENCE_TABLE: true,
    };
    // 表示中の種別だけにエッジを絞り込んだグラフを返す
    const filteredGraph = (): TraceGraph => ({
      ...graph,
      edges: graph.edges.filter((e) => visibleKinds[e.kind]),
    });

    const filterBar = document.createElement("div");
    filterBar.style.cssText =
      "display: flex; gap: 16px; margin: 0 0 6px 0; font-size: 0.8em; color: #555;";
    const makeToggle = (kind: string, text: string): HTMLLabelElement => {
      const label = document.createElement("label");
      label.style.cssText =
        "display: inline-flex; align-items: center; gap: 4px; cursor: pointer;";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true;
      cb.onchange = () => {
        visibleKinds[kind] = cb.checked;
        setKindVisible(kind, cb.checked);
      };
      label.appendChild(cb);
      label.appendChild(document.createTextNode(text));
      return label;
    };
    filterBar.appendChild(makeToggle("LOOKUP", "📥 ルックアップ"));
    filterBar.appendChild(makeToggle("REFERENCE_TABLE", "👀 関連レコード"));
    container.appendChild(filterBar);

    const svgWrap = document.createElement("div");
    svgWrap.style.cssText = "overflow: auto; max-height: 60vh;";
    svgWrap.appendChild(svg);
    container.appendChild(svgWrap);

    const btnBar = document.createElement("div");
    btnBar.style.cssText = "display: flex; gap: 8px; margin-top: 10px;";

    const imageBtn = makeButton("画像をコピー", "#8e44ad");
    imageBtn.onclick = async () => {
      const ok = await copyGraphImage(svg);
      imageBtn.textContent = ok ? "コピーしました" : "コピー失敗";
      setTimeout(() => {
        imageBtn.textContent = "画像をコピー";
      }, 1500);
    };

    const mermaidBtn = makeButton("Mermaidをコピー", "#8e44ad");
    mermaidBtn.onclick = async () => {
      const ok = await copyTextToClipboard(toMermaid(filteredGraph()));
      mermaidBtn.textContent = ok ? "コピーしました" : "コピー失敗";
      setTimeout(() => {
        mermaidBtn.textContent = "Mermaidをコピー";
      }, 1500);
    };

    const dotBtn = makeButton("DOTをコピー", "#8e44ad");
    dotBtn.onclick = async () => {
      const ok = await copyTextToClipboard(toDot(filteredGraph()));
      dotBtn.textContent = ok ? "コピーしました" : "コピー失敗";
      setTimeout(() => {
        dotBtn.textContent = "DOTをコピー";
      }, 1500);
    };

    // draw.io は現在の配置（ドラッグ後の座標）を反映して出力
    const drawioBtn = makeButton("draw.ioをコピー", "#8e44ad");
    drawioBtn.onclick = async () => {
      const ok = await copyTextToClipboard(
        toDrawioXml(filteredGraph(), positions, layout, startAppId),
      );
      drawioBtn.textContent = ok ? "コピーしました" : "コピー失敗";
      setTimeout(() => {
        drawioBtn.textContent = "draw.ioをコピー";
      }, 1500);
    };

    btnBar.appendChild(imageBtn);
    btnBar.appendChild(mermaidBtn);
    btnBar.appendChild(dotBtn);
    btnBar.appendChild(drawioBtn);
    container.appendChild(btnBar);

    return container;
  };

  // ---- 共通ボタン ----------------------------------------------------------

  const makeButton = (text: string, bg: string): HTMLButtonElement => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = text;
    btn.style.cssText = `padding: 6px 12px; background: ${bg}; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 0.85em;`;
    return btn;
  };

  // ---- ダイアログ本体 ------------------------------------------------------

  const showDialog = (graph: TraceGraph, startAppId: string): void => {
    document.getElementById(OVERLAY_ID)?.remove();
    document.getElementById(DIALOG_ID)?.remove();

    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.style.cssText =
      "position: fixed; inset: 0; background: rgba(0,0,0,0.3); z-index: 2147483646;";
    overlay.onclick = () => {
      overlay.remove();
      dialog.remove();
    };

    const dialog = document.createElement("div");
    dialog.id = DIALOG_ID;
    dialog.style.cssText =
      "position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: #fff; padding: 20px; border-radius: 8px; box-shadow: 0 2px 12px rgba(0,0,0,0.2); z-index: 2147483647; width: 860px; max-width: 92vw; max-height: 88vh; overflow: auto; color: #333; text-align: left;";
    dialog.onclick = (e) => e.stopPropagation();

    const title = document.createElement("h3");
    title.textContent = "参照トレース";
    title.style.cssText = "margin: 0 0 4px 0; text-align: center;";
    dialog.appendChild(title);

    const summary = document.createElement("p");
    const incomingText = graph.incomingCount
      ? ` / 被参照アプリ数: ${graph.incomingCount}`
      : "";
    summary.textContent = `起点アプリ: ${startAppId} / 対象アプリ数: ${graph.nodes.length}${incomingText} / 参照フィールド数: ${graph.rows.length}`;
    summary.style.cssText =
      "margin: 0 0 10px 0; text-align: center; font-size: 0.85em; color: #555;";
    dialog.appendChild(summary);

    if (graph.truncated) {
      const warn = document.createElement("p");
      warn.textContent = `※ 参照アプリが多いため ${MAX_APPS} 件で打ち切りました。`;
      warn.style.cssText =
        "margin: 0 0 8px 0; text-align: center; font-size: 0.8em; color: #c62828;";
      dialog.appendChild(warn);
    }

    if (graph.spaceScanLimited) {
      const warn = document.createElement("p");
      warn.textContent = `※ 同スペースのアプリが多いため被参照スキャンを ${graph.spaceScanCount} 件までに制限しました。`;
      warn.style.cssText =
        "margin: 0 0 8px 0; text-align: center; font-size: 0.8em; color: #c62828;";
      dialog.appendChild(warn);
    }

    const note = document.createElement("p");
    note.textContent =
      graph.startSpaceId != null
        ? `※ 参照先（outgoing）は再帰的に辿ります。被参照（incoming）は起点と同じスペース内のアプリ${graph.spaceScanCount != null ? `（${graph.spaceScanCount}件走査）` : ""}のみ検出します。`
        : "※ 参照先（outgoing）は再帰的に辿ります。起点アプリがスペースに属さないため被参照（incoming）は検出できません。";
    note.style.cssText =
      "margin: 0 0 10px 0; text-align: center; font-size: 0.75em; color: #888;";
    dialog.appendChild(note);

    // タブ
    const tabBar = document.createElement("div");
    tabBar.style.cssText =
      "display: flex; gap: 4px; border-bottom: 2px solid #e0e0e0; margin-bottom: 12px;";
    const body = document.createElement("div");

    const tableView = renderTableView(graph);
    const graphView = renderGraphView(graph, startAppId);

    const tabDefs: { label: string; view: HTMLElement }[] = [
      { label: "表形式", view: tableView },
      { label: "グラフ", view: graphView },
    ];
    const tabButtons: HTMLButtonElement[] = [];

    const activate = (idx: number): void => {
      body.innerHTML = "";
      body.appendChild(tabDefs[idx].view);
      tabButtons.forEach((b, i) => {
        b.style.borderBottom =
          i === idx ? "3px solid #1e88e5" : "3px solid transparent";
        b.style.color = i === idx ? "#1e88e5" : "#555";
        b.style.fontWeight = i === idx ? "bold" : "normal";
      });
    };

    tabDefs.forEach((def, idx) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = def.label;
      b.style.cssText =
        "padding: 8px 16px; background: none; border: none; border-bottom: 3px solid transparent; cursor: pointer; font-size: 0.9em;";
      b.onclick = () => activate(idx);
      tabButtons.push(b);
      tabBar.appendChild(b);
    });

    dialog.appendChild(tabBar);
    dialog.appendChild(body);

    const closeBtn = makeButton("閉じる", "#95a5a6");
    closeBtn.style.marginTop = "16px";
    closeBtn.onclick = () => {
      overlay.remove();
      dialog.remove();
    };
    const closeWrap = document.createElement("div");
    closeWrap.style.cssText = "text-align: center;";
    closeWrap.appendChild(closeBtn);
    dialog.appendChild(closeWrap);

    document.body.appendChild(overlay);
    document.body.appendChild(dialog);

    activate(0);
  };

  // ---- ローディング表示 ----------------------------------------------------

  const showLoading = (): HTMLElement => {
    document.getElementById(OVERLAY_ID)?.remove();
    document.getElementById(DIALOG_ID)?.remove();
    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.style.cssText =
      "position: fixed; inset: 0; background: rgba(0,0,0,0.3); z-index: 2147483646; display: flex; align-items: center; justify-content: center;";
    const box = document.createElement("div");
    box.style.cssText =
      "background: #fff; padding: 20px 28px; border-radius: 8px; color: #333; font-size: 0.9em;";
    box.textContent = "参照関係を解析中…";
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    return overlay;
  };

  // ---- エントリポイント ----------------------------------------------------

  const run = async (): Promise<void> => {
    const api = getApi();
    if (!api) {
      alert("kintone API が利用できません。kintoneのアプリページで実行してください。");
      return;
    }
    if (typeof kintone === "undefined" || !kintone.app) {
      alert("kintone.app が利用できません。アプリのレコード/設定ページで実行してください。");
      return;
    }
    const appId = kintone.app.getId();
    if (appId === null || appId === undefined) {
      alert("アプリIDを取得できませんでした。アプリのページで実行してください。");
      return;
    }

    const loading = showLoading();
    try {
      const graph = await buildGraph(api, String(appId));
      loading.remove();
      showDialog(graph, String(appId));
    } catch (err) {
      loading.remove();
      console.error("[Kintone Dev Tools] fieldTrace failed:", err);
      alert(
        `参照トレースの実行中にエラーが発生しました。\n${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };

  if (
    document.readyState === "complete" ||
    document.readyState === "interactive"
  ) {
    run();
  } else {
    document.addEventListener("DOMContentLoaded", run);
  }
})();
