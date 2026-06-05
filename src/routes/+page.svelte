<script lang="ts">
  // Nebula app shell — FR-UI-001 split-pane (vault | chat) wired to the REAL RAG pipeline:
  // chunk → bge embed → SurrealDB HNSW (indxdb) → cosine retrieve → WebLLM grounded answer
  // → clickable [#n] citations that highlight the source (FR-CHAT-003). Runs in the browser.
  import { onMount, tick } from 'svelte';
  import type { SearchHit } from '$lib/inference/provider';

  type Note = { docId: string; text: string };
  type Cite = { n: number; chunkId: string; docId: string };

  const VAULT: Note[] = [
    {
      docId: 'notes/apollo.md',
      text: 'The Apollo project will ship to customers in the third quarter of next year. The release adds a new dashboard and an export API for power users.'
    },
    {
      docId: 'notes/refunds.md',
      text: 'Our refund policy lets customers return any product within thirty days of purchase for a full refund, no questions asked.'
    },
    {
      docId: 'notes/security.md',
      text: 'All vault data stays on the local device. Nebula never uploads note content to any server; the Context Compiler is the only path that can export text, and only with consent.'
    },
    {
      docId: 'notes/cats.md',
      text: 'Cats are small domesticated carnivores. They are entirely unrelated to the product roadmap.'
    }
  ];

  const MODELS = [
    { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Llama-3.2-1B (fast)' },
    { id: 'Phi-3-mini-4k-instruct-q4f16_1-MLC', label: 'Phi-3-mini (default)' },
    { id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', label: 'Qwen2.5-0.5B (tiny)' }
  ];

  let status = $state('starting…');
  let ready = $state(false);
  let modelId = $state(MODELS[0].id);
  let query = $state('Does Nebula upload my notes to a server?');
  let answer = $state('');
  let cites = $state<Cite[]>([]);
  let hits = $state<SearchHit[]>([]);
  let activeDoc = $state<string | null>(null);
  let busy = $state(false);
  let ttft = $state(0);
  let tps = $state(0);
  let coi = $state(false);

  // lazily-loaded heavy modules (browser only)
  let pipe: {
    embed: (t: string) => Promise<number[]>;
    search: (v: number[], k: number) => Promise<SearchHit[]>;
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
    contextOrder: () => string[];
  } | null = null;
  let loadedModel = '';

  onMount(async () => {
    coi = crossOriginIsolated;
    const [
      { chunk },
      { embed, embedBatch, makeBgeTokenCounter },
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
      provider,
      contextOrder: () => hits.map((h) => h.chunkId)
    };
    status = 'ready';
    ready = true;
  });

  async function ask() {
    if (!pipe || busy || !query.trim()) return;
    busy = true;
    answer = '';
    cites = [];
    activeDoc = null;
    try {
      status = 'embedding query…';
      const qv = await pipe.embed(query);
      status = 'retrieving…';
      hits = await pipe.search(qv, 4);

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
      status = 'done';
      await tick();
    } catch (e) {
      status = 'error: ' + (e instanceof Error ? e.message : String(e));
    } finally {
      busy = false;
    }
  }

  function showSource(docId: string) {
    activeDoc = docId;
  }
</script>

<main class="shell">
  <header class="topbar">
    <span class="brand">✦ Nebula</span>
    <span class="tag">local-first RAG</span>
    <span class="status">{status}{ready && ttft ? ` · TTFT ${ttft}ms · ${tps} tok/s` : ''}</span>
    <span class="coi" class:ok={coi}>{coi ? 'isolated ✓' : 'not isolated'}</span>
  </header>

  <div class="split">
    <section class="pane vault" aria-label="Vault">
      <h2>Vault</h2>
      {#each VAULT as note (note.docId)}
        <div class="note" class:active={activeDoc === note.docId}>
          <div class="note-title">{note.docId}</div>
          <div class="note-body">{note.text}</div>
        </div>
      {/each}
    </section>

    <div class="divider"></div>

    <section class="pane chat" aria-label="Chat">
      <h2>Ask your vault</h2>

      <div class="controls">
        <select bind:value={modelId} disabled={busy}>
          {#each MODELS as m (m.id)}<option value={m.id}>{m.label}</option>{/each}
        </select>
      </div>

      <textarea bind:value={query} rows="2" placeholder="Ask a question…" disabled={busy}
      ></textarea>
      <button onclick={ask} disabled={!ready || busy}>{busy ? 'Working…' : 'Ask'}</button>

      {#if hits.length}
        <div class="sources">
          <div class="sources-h">Retrieved sources</div>
          {#each hits as h, i (h.chunkId)}
            <button class="src" onclick={() => showSource(h.docId)}>
              <span class="src-n">[#{i + 1}]</span>
              {h.docId} <span class="score">{h.score.toFixed(2)}</span>
            </button>
          {/each}
        </div>
      {/if}

      {#if answer}
        <div class="answer">
          <div class="answer-h">Answer</div>
          <p>{answer}</p>
          {#if cites.length}
            <div class="cites">
              cited:
              {#each cites as c (c.chunkId)}
                <button class="chip" onclick={() => showSource(c.docId)}>[#{c.n}] {c.docId}</button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </section>
  </div>
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
    flex: 1;
    overflow: auto;
    padding: 1rem 1.1rem;
  }
  .vault {
    max-width: 46%;
    border-right: 0;
  }
  .divider {
    width: 1px;
    background: #e4e4ea;
  }
  h2 {
    font-size: 0.9rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #8a8a90;
    margin: 0 0 0.6rem;
  }
  .note {
    border: 1px solid #e8e8ee;
    border-radius: 10px;
    padding: 0.6rem 0.7rem;
    margin-bottom: 0.6rem;
    background: #fff;
    transition:
      box-shadow 0.15s,
      border-color 0.15s;
  }
  .note.active {
    border-color: #6750a4;
    box-shadow: 0 0 0 2px #6750a433;
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
  button {
    cursor: pointer;
  }
  .chat > button {
    margin-top: 0.5rem;
    background: #6750a4;
    color: #fff;
    border: 0;
    border-radius: 8px;
    padding: 0.5rem 1rem;
  }
  .chat > button:disabled {
    opacity: 0.5;
  }
  .sources {
    margin-top: 1rem;
  }
  .sources-h,
  .answer-h {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #9a9aa2;
    margin-bottom: 0.3rem;
  }
  .src {
    display: block;
    width: 100%;
    text-align: left;
    background: #fff;
    border: 1px solid #e8e8ee;
    border-radius: 8px;
    padding: 0.35rem 0.5rem;
    margin-bottom: 0.3rem;
    font-size: 0.8rem;
  }
  .src-n {
    color: #6750a4;
    font-weight: 600;
  }
  .score {
    float: right;
    color: #9a9aa2;
  }
  .answer {
    margin-top: 1.1rem;
    background: #fff;
    border: 1px solid #e8e8ee;
    border-radius: 12px;
    padding: 0.8rem 0.9rem;
  }
  .answer p {
    margin: 0;
    line-height: 1.5;
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
    background: #efeaf8;
    color: #6750a4;
    border: 0;
    border-radius: 999px;
    padding: 0.15rem 0.6rem;
    font-size: 0.76rem;
  }
</style>
