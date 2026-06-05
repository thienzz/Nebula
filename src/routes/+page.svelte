<script lang="ts">
  // Nebula workspace — the "Obsidian DNA" surfaces wired onto the REAL RAG pipeline:
  // chunk → bge embed → SurrealDB HNSW (indxdb) → cosine retrieve → WebLLM grounded answer.
  // 40/60 resizable split (FR-UI-001); right-pane document viewer with Magic Jump scroll +
  // yellow highlight of the cited span (FR-CHAT-003); the Weaver auto-wikilinks the answer
  // with hover popovers (FR-LINK-001/002); the Micro-Map renders the retrieval sub-graph
  // (FR-GRAPH-001/002); Export Vault downloads a portable .zip (FR-DATA-006). Runs in-browser.
  import { onMount, tick } from 'svelte';
  import type { SearchHit } from '$lib/inference/provider';
  import { buildTitleIndex, weaveLinks, notePreview, type WovenSegment } from '$lib/weave/weaver';
  import { buildMicroGraph, type MicroGraph } from '$lib/graph/micrograph';
  import { resolveCitationTarget, buildHighlightSegments } from '$lib/chat/citation';
  import { exportVaultZip } from '$lib/vault/export';

  type Note = { docId: string; title: string; aliases: string[]; text: string };
  type Cite = { n: number; chunkId: string; docId: string };

  const VAULT: Note[] = [
    {
      docId: 'notes/apollo.md',
      title: 'Apollo',
      aliases: ['Apollo project', 'dashboard', 'export API'],
      text: 'The Apollo project will ship to customers in the third quarter of next year. The release adds a new dashboard and an export API for power users.'
    },
    {
      docId: 'notes/refunds.md',
      title: 'refund policy',
      aliases: ['refund', 'refunds'],
      text: 'Our refund policy lets customers return any product within thirty days of purchase for a full refund, no questions asked.'
    },
    {
      docId: 'notes/security.md',
      title: 'security',
      aliases: ['vault data', 'Context Compiler'],
      text: 'All vault data stays on the local device. Nebula never uploads note content to any server; the Context Compiler is the only path that can export text, and only with consent.'
    },
    {
      docId: 'notes/cats.md',
      title: 'Cats',
      aliases: ['cat'],
      text: 'Cats are small domesticated carnivores. They are entirely unrelated to the product roadmap.'
    }
  ];

  const MODELS = [
    { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Llama-3.2-1B (fast)' },
    { id: 'Phi-3-mini-4k-instruct-q4f16_1-MLC', label: 'Phi-3-mini (default)' },
    { id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', label: 'Qwen2.5-0.5B (tiny)' }
  ];

  // The Weaver's title index (FR-LINK-001), built once from the vault note titles + aliases.
  const noteRefs = VAULT.map((n) => ({
    docId: n.docId,
    title: n.title,
    aliases: n.aliases,
    summary: n.text
  }));
  const titleIndex = buildTitleIndex(noteRefs);

  let status = $state('starting…');
  let ready = $state(false);
  let modelId = $state(MODELS[0].id);
  let query = $state('Does Nebula upload my notes to a server?');
  let answer = $state('');
  let woven = $state<WovenSegment[]>([]);
  let cites = $state<Cite[]>([]);
  let hits = $state<SearchHit[]>([]);
  let graph = $state<MicroGraph | null>(null);
  let activeDoc = $state<string | null>(null);
  let activeSpan = $state<{ charStart: number; charEnd: number } | null>(null);
  let busy = $state(false);
  let ttft = $state(0);
  let tps = $state(0);
  let coi = $state(false);

  // 40/60 resizable split (FR-UI-001).
  let leftPct = $state(40);
  let splitEl: HTMLDivElement;
  let dragging = $state(false);
  let preview = $state<{ text: string; x: number; y: number } | null>(null);

  let pipe: {
    embed: (t: string) => Promise<number[]>;
    search: (v: number[], k: number) => Promise<SearchHit[]>;
    relate: (qid: string, hs: SearchHit[]) => Promise<void>;
    provider: {
      loadModel: (m: string, cb: (p: number) => void) => Promise<void>;
      generate: (
        req: {
          requestId: string;
          query: string;
          context: SearchHit[];
          modelId: string;
          maxTokens: number;
        },
        onTok: (t: string) => void,
        sig: AbortSignal
      ) => Promise<{
        text: string;
        citations: { chunkId: string; spanInAnswer: [number, number] }[];
        ttftMs: number;
        tokensPerSec: number;
      }>;
    };
  } | null = null;
  let loadedModel = '';

  onMount(async () => {
    coi = crossOriginIsolated;
    const [
      { chunk },
      { embedBatch, makeBgeTokenCounter, embed },
      { VectorStore },
      { WebLLMProvider },
      { EMBEDDING_DIM }
    ] = await Promise.all([
      import('$lib/ingest/chunker'),
      import('$lib/embed/embedder'),
      import('$lib/db/store'),
      import('$lib/inference/webllm'),
      import('$lib/inference/provider')
    ]);

    status = 'loading embedder…';
    const countTokens = await makeBgeTokenCounter();
    const store = new VectorStore();
    try {
      await store.connect('indxdb://nebula-app', EMBEDDING_DIM);
    } catch {
      await store.connect('mem://', EMBEDDING_DIM);
    }

    status = 'indexing vault…';
    for (const note of VAULT) {
      const cs = chunk(note.text, { size: 60, overlap: 12, countTokens });
      const vecs = await embedBatch(cs.map((c) => c.text));
      await store.upsertChunks(
        cs.map((c, i) => ({
          chunkId: `${note.docId}#${c.seq}`,
          docId: note.docId,
          text: c.text,
          page: c.page,
          charStart: c.charStart,
          charEnd: c.charEnd,
          embedding: vecs[i]
        }))
      );
    }

    const provider = new WebLLMProvider();
    pipe = {
      embed,
      search: (v, k) => store.search(v, k),
      relate: (qid, hs) =>
        store.relateRetrieval(
          qid,
          hs.map((h) => ({ chunkId: h.chunkId, score: h.score }))
        ),
      provider
    };
    status = 'ready';
    ready = true;
  });

  async function ask() {
    if (!pipe || busy || !query.trim()) return;
    busy = true;
    answer = '';
    woven = [];
    cites = [];
    graph = null;
    activeDoc = null;
    activeSpan = null;
    try {
      status = 'embedding query…';
      const qv = await pipe.embed(query);
      status = 'retrieving…';
      hits = await pipe.search(qv, 4);
      // Micro-Map (FR-GRAPH-001) + persist the retrieval sub-graph edges (FR-GRAPH-002).
      graph = buildMicroGraph(query, hits);
      try {
        await pipe.relate('current', hits);
      } catch {
        /* edge persistence is best-effort; the visual graph is built from hits */
      }

      if (loadedModel !== modelId) {
        status = 'loading model…';
        await pipe.provider.loadModel(
          modelId,
          (p) => (status = `loading model ${(p * 100).toFixed(0)}%`)
        );
        loadedModel = modelId;
      }

      status = 'generating…';
      const res = await pipe.provider.generate(
        { requestId: 'q', query, context: hits, modelId, maxTokens: 256 },
        (t) => {
          answer += t;
        },
        new AbortController().signal
      );
      ttft = res.ttftMs;
      tps = Math.round(res.tokensPerSec);
      const order = hits.map((h) => h.chunkId);
      cites = res.citations.map((c) => {
        const docId = order.find((id) => id === c.chunkId) ? c.chunkId.split('#')[0] : c.chunkId;
        const n = order.indexOf(c.chunkId) + 1;
        return { n, chunkId: c.chunkId, docId };
      });
      // The Weaver (FR-LINK-001): wrap note-title mentions in the finished answer as links.
      woven = weaveLinks(answer, titleIndex, { once: true });
      status = 'done';
      await tick();
    } catch (e) {
      status = 'error: ' + (e instanceof Error ? e.message : String(e));
    } finally {
      busy = false;
    }
  }

  // Magic Jump (FR-CHAT-003): open the cited chunk's document and highlight its exact span.
  function jumpTo(chunkId: string) {
    const target = resolveCitationTarget(chunkId, hits);
    if (!target) return;
    activeDoc = target.docId;
    activeSpan = { charStart: target.charStart, charEnd: target.charEnd };
  }

  function showSource(docId: string) {
    activeDoc = docId;
    activeSpan = null;
  }

  function exportVault() {
    const zip = exportVaultZip({
      notes: VAULT.map((n) => ({ path: n.docId, frontmatter: { title: n.title }, body: n.text }))
    });
    const url = URL.createObjectURL(new Blob([new Uint8Array(zip)], { type: 'application/zip' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'nebula-vault.zip';
    a.click();
    URL.revokeObjectURL(url);
  }

  // Weaver popover (FR-LINK-002).
  function showPreview(e: MouseEvent, docId: string) {
    const ref = noteRefs.find((r) => r.docId === docId);
    preview = {
      text: notePreview({ summary: ref?.summary }),
      x: e.clientX + 12,
      y: e.clientY + 12
    };
  }
  const hidePreview = () => (preview = null);

  // Resizable divider.
  function startDrag(e: PointerEvent) {
    dragging = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onDrag(e: PointerEvent) {
    if (!dragging || !splitEl) return;
    const rect = splitEl.getBoundingClientRect();
    leftPct = Math.min(70, Math.max(25, ((e.clientX - rect.left) / rect.width) * 100));
  }
  function endDrag() {
    dragging = false;
  }
  function dividerKey(e: KeyboardEvent) {
    if (e.key === 'ArrowLeft') leftPct = Math.max(25, leftPct - 2);
    if (e.key === 'ArrowRight') leftPct = Math.min(70, leftPct + 2);
  }

  const activeNote = $derived(activeDoc ? VAULT.find((n) => n.docId === activeDoc) : undefined);
</script>

<main class="shell">
  <header class="topbar">
    <span class="brand">✦ Nebula</span>
    <span class="tag">local-first RAG · Obsidian DNA</span>
    <button
      class="eject"
      onclick={exportVault}
      title="Export the whole vault as a portable .zip (FR-DATA-006)"
    >
      ⤓ Export Vault
    </button>
    <span class="status">{status}{ready && ttft ? ` · TTFT ${ttft}ms · ${tps} tok/s` : ''}</span>
    <span class="coi" class:ok={coi}>{coi ? 'isolated ✓' : 'not isolated'}</span>
  </header>

  <div class="split" bind:this={splitEl}>
    <!-- LEFT (40%) — the Active/Command zone: chat + Micro-Map -->
    <section class="pane chat" style="width: {leftPct}%" aria-label="Chat">
      <h2>Ask your vault</h2>

      <div class="controls">
        <select bind:value={modelId} disabled={busy}>
          {#each MODELS as m (m.id)}<option value={m.id}>{m.label}</option>{/each}
        </select>
      </div>

      <textarea bind:value={query} rows="2" placeholder="Ask a question…" disabled={busy}
      ></textarea>
      <button class="ask" onclick={ask} disabled={!ready || busy}
        >{busy ? 'Working…' : 'Ask'}</button
      >

      {#if hits.length}
        <div class="sources">
          <div class="block-h">Retrieved sources</div>
          {#each hits as h, i (h.chunkId)}
            <button class="src" onclick={() => jumpTo(h.chunkId)}>
              <span class="src-n">[#{i + 1}]</span>
              {h.docId} <span class="score">{h.score.toFixed(2)}</span>
            </button>
          {/each}
        </div>
      {/if}

      {#if graph}
        <div class="micromap">
          <div class="block-h">Micro-Map · how the AI answered</div>
          <svg
            width="100%"
            height={40 + graph.nodes.filter((n) => n.kind === 'chunk').length * 30}
            class="graph"
          >
            {#each graph.edges as e, i (e.to)}
              {@const cy = 30 + i * 30}
              <line
                x1="78"
                y1="24"
                x2="76%"
                y2={cy}
                stroke="#6750a4"
                stroke-width={e.width}
                stroke-opacity="0.55"
              />
            {/each}
            <circle cx="40" cy="24" r="9" fill="#6750a4" />
            <text x="40" y="44" text-anchor="middle" class="g-label">query</text>
            {#each graph.nodes.filter((n) => n.kind === 'chunk') as n, i (n.id)}
              {@const cy = 30 + i * 30}
              <circle cx="76%" {cy} r="6" fill="#efeaf8" stroke="#6750a4" />
              <text x="80%" y={cy + 4} class="g-label">{n.label} · {n.score}</text>
            {/each}
          </svg>
        </div>
      {/if}

      {#if answer}
        <div class="answer">
          <div class="block-h">Answer</div>
          {#if woven.length}
            <p>
              {#each woven as seg, i (i)}
                {@const link = seg.link}
                {#if link}
                  <button
                    class="wikilink"
                    onclick={() => showSource(link.docId)}
                    onmouseenter={(e) => showPreview(e, link.docId)}
                    onmouseleave={hidePreview}>{seg.text}</button
                  >
                {:else}{seg.text}{/if}
              {/each}
            </p>
          {:else}
            <p>{answer}</p>
          {/if}
          {#if cites.length}
            <div class="cites">
              cited:
              {#each cites as c (c.chunkId)}
                <button class="chip" onclick={() => jumpTo(c.chunkId)}>[#{c.n}] {c.docId}</button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </section>

    <!-- Window-splitter: an intentionally interactive separator (pointer drag + arrow keys). -->
    <button
      class="divider"
      class:dragging
      onpointerdown={startDrag}
      onpointermove={onDrag}
      onpointerup={endDrag}
      onkeydown={dividerKey}
      aria-label="Resize panes (arrow keys)"
    ></button>

    <!-- RIGHT (60%) — the Reference zone: document viewer / vault -->
    <section class="pane viewer" aria-label="Document viewer">
      {#if activeNote}
        <div class="block-h">
          {activeNote.docId}{activeSpan ? ' · cited span highlighted' : ''}
          <button class="back" onclick={() => (activeDoc = null)}>✕ vault</button>
        </div>
        <article class="doc">
          {#if activeSpan}
            {@const seg = buildHighlightSegments(
              activeNote.text,
              activeSpan.charStart,
              activeSpan.charEnd
            )}
            {seg.pre}<mark>{seg.hit}</mark>{seg.post}
          {:else}
            {activeNote.text}
          {/if}
        </article>
      {:else}
        <div class="block-h">Vault — {VAULT.length} notes</div>
        {#each VAULT as note (note.docId)}
          <button class="note" onclick={() => showSource(note.docId)}>
            <div class="note-title">{note.docId}</div>
            <div class="note-body">{note.text}</div>
          </button>
        {/each}
      {/if}
    </section>
  </div>

  {#if preview}
    <div class="popover" style="left: {preview.x}px; top: {preview.y}px">{preview.text}</div>
  {/if}
</main>

<style>
  :global(body) {
    margin: 0;
  }
  .shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
    font-family: system-ui, sans-serif;
    color: #1c1c22;
    background: #fafafb;
  }
  .topbar {
    display: flex;
    align-items: center;
    gap: 0.8rem;
    padding: 0.55rem 1rem;
    border-bottom: 1px solid #e4e4ea;
    background: #fff;
  }
  .brand {
    font-weight: 700;
    color: #6750a4;
  }
  .tag {
    font-size: 0.75rem;
    color: #8a8a90;
  }
  .eject {
    font: inherit;
    font-size: 0.76rem;
    cursor: pointer;
    background: #efeaf8;
    color: #6750a4;
    border: 1px solid #d9cef2;
    border-radius: 7px;
    padding: 0.2rem 0.55rem;
  }
  .status {
    margin-left: auto;
    font-size: 0.8rem;
    color: #6a6a72;
  }
  .coi {
    font-size: 0.72rem;
    color: #b00020;
    border: 1px solid currentColor;
    border-radius: 6px;
    padding: 1px 6px;
  }
  .coi.ok {
    color: #1a7f37;
  }
  .split {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .pane {
    overflow: auto;
    padding: 1rem 1.1rem;
  }
  .viewer {
    flex: 1;
    background: #fff;
  }
  .divider {
    width: 6px;
    padding: 0;
    border: 0;
    cursor: col-resize;
    background: #e4e4ea;
    flex: 0 0 auto;
  }
  .divider.dragging,
  .divider:hover {
    background: #c9c2e6;
  }
  .divider:focus-visible {
    outline: 2px solid #6750a4;
  }
  h2 {
    font-size: 0.9rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #8a8a90;
    margin: 0 0 0.6rem;
  }
  .block-h {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #9a9aa2;
    margin-bottom: 0.3rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .back {
    margin-left: auto;
    font: inherit;
    font-size: 0.7rem;
    cursor: pointer;
    border: 0;
    background: #f0f0f4;
    border-radius: 6px;
    padding: 0.1rem 0.4rem;
    color: #6a6a72;
  }
  .note {
    display: block;
    width: 100%;
    text-align: left;
    cursor: pointer;
    border: 1px solid #e8e8ee;
    border-radius: 10px;
    padding: 0.6rem 0.7rem;
    margin-bottom: 0.6rem;
    background: #fff;
  }
  .note:hover {
    border-color: #6750a4;
  }
  .note-title {
    font-weight: 600;
    font-size: 0.82rem;
    color: #444;
  }
  .note-body {
    font-size: 0.82rem;
    color: #555;
    margin-top: 0.25rem;
  }
  .doc {
    font-size: 0.9rem;
    line-height: 1.6;
    white-space: pre-wrap;
    color: #2a2a30;
  }
  mark {
    background: #fff3a3;
    border-radius: 3px;
    padding: 0 2px;
  }
  .controls {
    margin-bottom: 0.5rem;
  }
  select,
  textarea,
  button {
    font: inherit;
  }
  textarea {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid #d8d8e0;
    border-radius: 8px;
    padding: 0.5rem;
    resize: vertical;
  }
  .ask {
    margin-top: 0.5rem;
    cursor: pointer;
    background: #6750a4;
    color: #fff;
    border: 0;
    border-radius: 8px;
    padding: 0.5rem 1rem;
  }
  .ask:disabled {
    opacity: 0.5;
  }
  .sources,
  .micromap,
  .answer {
    margin-top: 1rem;
  }
  .src {
    display: block;
    width: 100%;
    text-align: left;
    cursor: pointer;
    background: #fff;
    border: 1px solid #e8e8ee;
    border-radius: 8px;
    padding: 0.35rem 0.5rem;
    margin-bottom: 0.3rem;
    font-size: 0.8rem;
  }
  .src:hover {
    border-color: #6750a4;
  }
  .src-n {
    color: #6750a4;
    font-weight: 600;
  }
  .score {
    float: right;
    color: #9a9aa2;
  }
  .graph {
    background: #fff;
    border: 1px solid #e8e8ee;
    border-radius: 10px;
  }
  .g-label {
    font-size: 9px;
    fill: #6a6a72;
  }
  .answer {
    background: #fff;
    border: 1px solid #e8e8ee;
    border-radius: 12px;
    padding: 0.8rem 0.9rem;
  }
  .answer p {
    margin: 0;
    line-height: 1.5;
  }
  .wikilink {
    cursor: pointer;
    border: 0;
    background: none;
    padding: 0;
    color: #6750a4;
    font: inherit;
    text-decoration: underline dotted;
  }
  .cites {
    margin-top: 0.6rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    align-items: center;
    font-size: 0.78rem;
    color: #8a8a90;
  }
  .chip {
    cursor: pointer;
    background: #efeaf8;
    color: #6750a4;
    border: 0;
    border-radius: 999px;
    padding: 0.15rem 0.6rem;
    font-size: 0.76rem;
  }
  .popover {
    position: fixed;
    max-width: 280px;
    background: #1c1c22;
    color: #f3f3f6;
    font-size: 0.76rem;
    line-height: 1.4;
    padding: 0.4rem 0.55rem;
    border-radius: 8px;
    pointer-events: none;
    z-index: 10;
    box-shadow: 0 4px 16px #0003;
  }
</style>
