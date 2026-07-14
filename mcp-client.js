/* ═══════════════════════════════════════════════════════════════════════════
   MCP Client-Side Converter
   Converts video-creator-mcp recipe JSON → FableCut project.json IN THE BROWSER.
   No server needed — works on GitHub Pages.
   
   Usage in browser:
     const project = await McpClient.importRecipe('2c9d1f6c90ec');
     // → returns FableCut project.json object
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";

const McpClient = (() => {

const MCP_BASE_URL = "https://s3-api.t3ks.com/video-mcp";

const RESOLUTION_MAP = {
  landscape: { width: 1920, height: 1080 },
  portrait: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
  "1080p": { width: 1920, height: 1080 },
  "4k": { width: 3840, height: 2160 },
  uhd: { width: 3840, height: 2160 },
};

/* ── Layout position calculator ── */
function layoutToPositions(layout, count) {
  if (!count || count === 0) return [];
  if (layout === "grid") {
    const cols = count <= 2 ? 2 : count <= 4 ? 2 : 3;
    const rows = Math.ceil(count / cols);
    return Array.from({ length: count }, (_, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      return {
        x: ((col - (cols - 1) / 2) / cols) * 100,
        y: ((row - (rows - 1) / 2) / rows) * 100,
        scale: 1 / Math.max(cols, rows),
      };
    });
  }
  if (layout === "vstack") {
    return Array.from({ length: count }, (_, i) => ({ y: i === 0 ? -25 : 25, x: 0, scale: 0.5 }));
  }
  if (layout === "hstack") {
    return Array.from({ length: count }, (_, i) => ({ x: i === 0 ? -25 : 25, y: 0, scale: 0.5 }));
  }
  if (layout === "pip") {
    return Array.from({ length: count }, (_, i) =>
      i === 0 ? { x: 0, y: 0, scale: 1 } : { x: 30, y: -30, scale: 0.3 });
  }
  return Array.from({ length: count }, () => ({ x: 0, y: 0, scale: 1 }));
}

/* ── Fetch JSON from URL ── */
async function fetchJSON(url) {
  const resp = await fetch(url, { mode: "cors" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  return resp.json();
}

/* ── Guess kind from URL ── */
function guessKind(url) {
  try {
    const ext = new URL(url).pathname.split('.').pop().toLowerCase();
    if (["mp4","webm","mov","mkv","m4v"].includes(ext)) return "video";
    if (["mp3","wav","ogg","m4a","aac","flac"].includes(ext)) return "audio";
    if (["png","jpg","jpeg","gif","webp"].includes(ext)) return "image";
    if (["svg"].includes(ext)) return "svg";
  } catch {}
  return "video";
}

function guessName(url) {
  try { return new URL(url).pathname.split('/').pop(); }
  catch { return "media_" + Math.random().toString(36).slice(2,8); }
}

/* ── Main: fetch recipe + convert ── */
async function importRecipe(projectId) {
  const recipeUrl = `${MCP_BASE_URL}/${projectId}.json`;
  console.log(`[MCP] Fetching: ${recipeUrl}`);
  
  let recipe = await fetchJSON(recipeUrl);
  
  // The bucket wraps recipe under a "recipe" key with metadata
  if (recipe.recipe && recipe.recipe.tool) {
    recipe = recipe.recipe;
  }
  
  const project = convertRecipe(recipe);
  project.name = recipe.title || `${projectId} — MCP Import`;
  project.revision = 1;
  
  console.log(`[MCP] Converted: ${project.clips.length} clips, ${project.media.length} media`);
  return { project, recipe };
}

function convertRecipe(recipe) {
  const tool = recipe.tool || "video_compose";
  const args = recipe.args || recipe;

  let composition, mediaMap = {};

  if (tool === "video_compose" || tool === "video_plan") {
    composition = args.composition || args;
    mediaMap = args.media || {};
  } else if (tool === "video_edit") {
    composition = convertEditToComposition(args);
    for (const m of args.media || []) {
      if (m.media_id) mediaMap[m.media_id] = m.url || m.src || "";
    }
  } else if (tool === "video_render_slideshow") {
    composition = convertSlideshowToComposition(args);
    for (const seg of args.segments || []) {
      if (seg.media_id) mediaMap[seg.media_id] = seg.media_url || "";
    }
  } else if (tool === "video_narrated_scenes") {
    composition = convertNarratedScenesToComposition(args);
    for (const scene of args.scenes || []) {
      if (scene.media_id) mediaMap[scene.media_id] = scene.media_url || "";
    }
  } else {
    composition = args.composition || args;
    mediaMap = args.media || {};
  }

  const output = composition.output || {};
  const resKey = output.resolution || "landscape";
  const dims = RESOLUTION_MAP[resKey] || RESOLUTION_MAP.landscape;

  const project = {
    name: composition.name || args.title || "MCP Import",
    width: dims.width,
    height: dims.height,
    fps: output.fps || 30,
    background: "#000000",
    revision: 0,
    markers: [],
    media: [],
    clips: [],
  };

  // Build media entries (keep remote URLs — CORS allows it)
  const mediaIdMap = {};
  for (const [mcpId, url] of Object.entries(mediaMap)) {
    if (!url) continue;
    const fableId = "m_" + mcpId;
    mediaIdMap[mcpId] = fableId;
    project.media.push({
      id: fableId,
      name: guessName(url),
      kind: guessKind(url),
      src: url, // remote URL — CORS is open on the bucket
    });
  }

  // Convert clips
  let clipCounter = 0;
  const nextId = () => "c_mcp" + (clipCounter++).toString(36);

  if (composition.tracks) {
    for (const track of composition.tracks) {
      if (!track.clips) continue;
      let cursor = 0;
      for (const clip of track.clips) {
        if (clip.type === "composition") {
          const nestedTracks = clip.tracks || [];
          const layout = clip.layout || "single";
          let nestedIdx = 0;
          const positions = layoutToPositions(layout, nestedTracks[0]?.clips?.length || 0);
          for (let ti = 0; ti < nestedTracks.length; ti++) {
            const nt = nestedTracks[ti];
            if (!nt.clips) continue;
            for (const nc of nt.clips) {
              const pos = positions[nestedIdx] || { x: 0, y: 0, scale: 1 };
              const fc = convertClip(nc, mediaIdMap, nextId, cursor, ti, pos);
              if (fc) { const a = Array.isArray(fc) ? fc : [fc]; project.clips.push(...a); }
              nestedIdx++;
            }
          }
          cursor += clip.duration === "fit" ? 10 : (clip.duration || 10);
        } else {
          const fc = convertClip(clip, mediaIdMap, nextId, cursor, 0);
          if (fc) {
            const a = Array.isArray(fc) ? fc : [fc];
            for (const f of a) {
              project.clips.push(f);
              cursor = Math.max(cursor, (f.start||0) + (f.duration||0));
            }
          }
        }
      }
    }
  }

  if (project.clips.length === 0) {
    project.clips.push({
      id: nextId(), kind: "text", mediaId: null, track: "V1",
      start: 0, duration: 5, name: "placeholder",
      props: { text: "No clips found in recipe", fontSize: 48, color: "#888888" },
    });
  }

  return project;
}

function convertClip(mcpClip, mediaIdMap, nextId, cursor, trackIdx, position) {
  const type = mcpClip.type;
  const id = nextId();
  const start = mcpClip.start !== undefined ? mcpClip.start : cursor;
  const duration = mcpClip.duration !== undefined
    ? (mcpClip.duration === "fit" ? 5 : mcpClip.duration) : 5;
  const pos = position || { x: 0, y: 0, scale: 1 };

  if (type === "video") {
    const mediaId = mediaIdMap[mcpClip.media_id];
    if (!mediaId) return null;
    const inPoint = mcpClip.in !== undefined ? mcpClip.in : (mcpClip.start_in || 0);
    const outPoint = mcpClip.out !== undefined ? mcpClip.out : null;
    const clipDuration = outPoint ? (outPoint - inPoint) : (duration || 5);
    const c = {
      id, mediaId, kind: "video", track: `V${Math.min(trackIdx+1,4)}`,
      start, in: inPoint, duration: clipDuration, name: "video", props: {},
    };
    if (pos.scale !== 1 || pos.x !== 0 || pos.y !== 0) {
      c.props.scale = pos.scale; c.props.x = pos.x * 10; c.props.y = pos.y * 10;
    }
    if (mcpClip.volume !== undefined) c.props.volume = mcpClip.volume;
    if (mcpClip.muted) c.props.volume = 0;
    return c;
  }

  if (type === "graphic") {
    const graphicMediaId = mediaIdMap[mcpClip.media_id || mcpClip.id];
    if (graphicMediaId) {
      return { id, mediaId: graphicMediaId, kind: "image", track: `V${Math.min(trackIdx+1,4)}`,
        start, duration, name: mcpClip.title || `graphic_${mcpClip.kind}`, props: {} };
    }
    const label = mcpClip.kind === "math" ? `📐 ${mcpClip.latex || mcpClip.title || "math"}`
      : mcpClip.kind === "chart" ? "📊 chart" : `🎨 ${mcpClip.kind || "graphic"}`;
    return { id, kind: "text", mediaId: null, track: `V${Math.min(trackIdx+2,4)}`,
      start, duration, name: `graphic_${mcpClip.kind||"x"}`,
      props: { text: label, fontSize: 64, color: "#7b6cff", align: "center",
        bgColor: "#000000", bgOpacity: 0.5 } };
  }

  if (type === "voice") {
    const voiceMediaId = mediaIdMap[mcpClip.media_id];
    if (voiceMediaId) {
      return { id, mediaId: voiceMediaId, kind: "audio", track: `A${Math.min(trackIdx+1,3)}`,
        start, duration: mcpClip.duration || 5, name: "narration", props: { volume: 1 } };
    }
    return { id, kind: "text", mediaId: null, track: "V4",
      start, duration, name: "narration",
      props: { text: `🎙️ ${mcpClip.text || ""}`, fontSize: 36, color: "#ffd166",
        align: "center", bgColor: "#000000", bgOpacity: 0.6 } };
  }

  if (type === "caption") {
    return { id, kind: "text", mediaId: null, track: "V3", start, duration,
      name: "caption",
      props: { text: mcpClip.text || (mcpClip.from === "voice" ? "" : ""),
        fontSize: 72, color: "#00ffff", align: "center",
        strokeColor: "#000000", strokeWidth: 4, textAnim: "karaoke",
        bgColor: "#000000", bgOpacity: 0.4 } };
  }

  if (type === "audio" || type === "music") {
    const audioMediaId = mediaIdMap[mcpClip.media_id];
    if (!audioMediaId) return null;
    return { id, mediaId: audioMediaId, kind: "audio", track: `A${Math.min(trackIdx+1,3)}`,
      start, duration, name: "audio",
      props: { volume: mcpClip.volume !== undefined ? mcpClip.volume : 0.8 } };
  }

  if (type === "image") {
    const imgMediaId = mediaIdMap[mcpClip.media_id];
    if (!imgMediaId) return null;
    return { id, mediaId: imgMediaId, kind: "image", track: `V${Math.min(trackIdx+1,4)}`,
      start, duration, name: "image", props: {} };
  }

  if (type === "text" || type === "title") {
    return { id, kind: "text", mediaId: null, track: `V${Math.min(trackIdx+2,4)}`,
      start, duration, name: "text",
      props: { text: mcpClip.text || mcpClip.content || "",
        fontSize: mcpClip.fontSize || 72, color: mcpClip.color || "#ffffff", align: "center" } };
  }

  return null;
}

/* ── Format converters ── */
function convertEditToComposition(args) {
  const tracks = [];
  for (let gi = 0; gi < (args.groups||[]).length; gi++) {
    const group = args.groups[gi];
    const clips = [];
    let cursor = 0;
    for (const seg of group) {
      clips.push({ type: seg.media_id ? "video":"image", media_id: seg.media_id,
        start: cursor, duration: (seg.end||0)-(seg.start||0)||seg.duration||5,
        start_in: seg.start||0, volume: seg.volume, speed: seg.speed, name: `g${gi}` });
      cursor += clips[clips.length-1].duration;
    }
    tracks.push({ clips });
  }
  return { output: { resolution: args.resolution||"landscape", fps: args.fps||30 },
    tracks, name: args.metadata?.title || "Video Edit" };
}

function convertSlideshowToComposition(args) {
  const tracks = [{ clips: [] }];
  let cursor = 0;
  for (const seg of args.segments||[]) {
    tracks[0].clips.push({ type:"image", media_id: seg.media_id, start: cursor,
      duration: seg.duration_seconds||5, name:"slide" });
    if (seg.text) {
      if (!tracks[1]) tracks[1] = { clips: [] };
      tracks[1].clips.push({ type:"text", text: seg.text, start: cursor, duration: seg.duration_seconds||5 });
    }
    cursor += seg.duration_seconds || 5;
  }
  return { output:{ resolution: args.resolution||"landscape", fps: args.fps||30 },
    tracks, name: args.metadata?.title || "Slideshow" };
}

function convertNarratedScenesToComposition(args) {
  const tracks = [{ clips: [] }, { clips: [] }, { clips: [] }];
  let cursor = 0;
  for (const scene of args.scenes||[]) {
    const dur = 5;
    if (scene.media_id) {
      tracks[0].clips.push({ type:"video", media_id: scene.media_id, start: cursor, duration: dur });
    } else if (scene.math) {
      tracks[0].clips.push({ type:"graphic", kind:"math", latex: scene.math.latex,
        title: scene.math.title||"math", start: cursor, duration: dur });
    }
    if (scene.line) {
      tracks[1].clips.push({ type:"voice", text: scene.line, start: cursor, duration: dur });
      tracks[2].clips.push({ type:"caption", text: scene.line, from:"voice", start: cursor, duration: dur });
    }
    cursor += dur;
  }
  return { output:{ resolution: args.resolution||"landscape", fps:30, tail_sec: args.tail_sec||0.6 },
    tracks, name: args.metadata?.title || "Narrated" };
}

return { importRecipe, convertRecipe, MCP_BASE_URL };
})();
