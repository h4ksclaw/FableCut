/* ═══════════════════════════════════════════════════════════════════════════
   MCP Video Creator → FableCut converter
   Converts the video-creator-mcp recipe JSON format to FableCut's project.json

   Handles these MCP tool formats:
     - video_compose  (tracks → clips: video, graphic, voice, caption, composition)
     - video_edit     (groups of segments, layout, text, audio)
     - video_render_slideshow (segments with text + media_id)
     - video_render_timeline  (segments with html + duration + media)
     - video_narrated_scenes  (scenes with line + media_id/math)

   Clip type mapping:
     MCP video    → FableCut kind:video  track:V1
     MCP graphic  → FableCut kind:image/video (needs pre-rendered media_url)
     MCP voice    → FableCut kind:audio  track:A1 (needs pre-rendered audio_url)
     MCP caption  → FableCut kind:text   track:V2
     MCP text overlay → FableCut kind:text track:V2/V3

   Media references are resolved from the recipe's media map.
   ═══════════════════════════════════════════════════════════════════════════ */
"use strict";

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

/* Resolution presets matching the MCP format */
const RESOLUTION_MAP = {
  landscape: { width: 1920, height: 1080 },
  portrait: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
  "1080p": { width: 1920, height: 1080 },
  "4k": { width: 3840, height: 2160 },
  uhd: { width: 3840, height: 2160 },
};

/* Layout → track position mapping for grid/vstack/hstack/pip */
function layoutToPositions(layout, count) {
  if (!count || count === 0) return [];
  if (layout === "grid") {
    // 2x2 grid for up to 4, 3x3 for up to 9
    const cols = count <= 2 ? 2 : count <= 4 ? 2 : 3;
    const rows = Math.ceil(count / cols);
    return Array.from({ length: count }, (_, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      return {
        x: ((col - (cols - 1) / 2) / cols) * 100, // percentage-ish offsets
        y: ((row - (rows - 1) / 2) / rows) * 100,
        scale: 1 / Math.max(cols, rows),
      };
    });
  }
  if (layout === "vstack") {
    // Top/bottom split (shorts style)
    return Array.from({ length: count }, (_, i) => ({
      y: i === 0 ? -25 : 25,
      x: 0,
      scale: 0.5,
    }));
  }
  if (layout === "hstack") {
    // Left/right split
    return Array.from({ length: count }, (_, i) => ({
      x: i === 0 ? -25 : 25,
      y: 0,
      scale: 0.5,
    }));
  }
  if (layout === "pip") {
    // Main + picture-in-picture
    return Array.from({ length: count }, (_, i) =>
      i === 0 ? { x: 0, y: 0, scale: 1 } : { x: 30, y: -30, scale: 0.3 }
    );
  }
  // single
  return Array.from({ length: count }, () => ({ x: 0, y: 0, scale: 1 }));
}

const MCP_BASE_URL = process.env.MCP_BASE_URL || "https://s3-api.t3ks.com/video-mcp";
const MCP_RESOLVE_IP = process.env.MCP_RESOLVE_IP || ""; // e.g. "79.253.255.160" to bypass DNS

/* Fetch JSON from URL (supports http and https, zero deps) */
function fetchJSON(urlStr) {
  return new Promise((resolve, reject) => {
    // Apply DNS override if set
    let actualUrl = urlStr;
    let actualHost = "";
    if (MCP_RESOLVE_IP && urlStr.includes("s3-api.t3ks.com")) {
      actualHost = "s3-api.t3ks.com";
      actualUrl = urlStr.replace("s3-api.t3ks.com", MCP_RESOLVE_IP);
    }
    const lib = actualUrl.startsWith("https") ? https : http;
    const options = { timeout: 30000 };
    if (actualHost) options.headers = { Host: actualHost };
    const req = lib.get(actualUrl, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchJSON(res.headers.location));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} fetching ${urlStr}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (e) {
          reject(new Error(`Failed to parse JSON from ${urlStr}: ${e.message}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

/* Download a file to local path */
function downloadFile(urlStr, destPath) {
  return new Promise((resolve, reject) => {
    let actualUrl = urlStr;
    let actualHost = "";
    if (MCP_RESOLVE_IP && urlStr.includes("s3-api.t3ks.com")) {
      actualHost = "s3-api.t3ks.com";
      actualUrl = urlStr.replace("s3-api.t3ks.com", MCP_RESOLVE_IP);
    }
    const lib = actualUrl.startsWith("https") ? https : http;
    const options = { timeout: 120000 };
    if (actualHost) options.headers = { Host: actualHost };
    const req = lib.get(actualUrl, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(downloadFile(res.headers.location, destPath));
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} downloading ${urlStr}`));
      }
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
      file.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

/* Guess media kind from URL extension */
function guessKind(url) {
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  if ([".mp4", ".webm", ".mov", ".mkv", ".m4v"].includes(ext)) return "video";
  if ([".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac"].includes(ext)) return "audio";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) return "image";
  if ([".svg"].includes(ext)) return "svg";
  return "video"; // default
}

function guessName(url) {
  try {
    return path.basename(new URL(url).pathname);
  } catch {
    return "media_" + Math.random().toString(36).slice(2, 8);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   Convert MCP recipe → FableCut project
   ═══════════════════════════════════════════════════════════════════════════ */

async function convertRecipe(recipe, mediaDir) {
  const tool = recipe.tool || "video_compose";
  const args = recipe.args || recipe;

  let composition;
  let mediaMap = {};

  /* ── Extract composition + media map based on tool type ── */

  if (tool === "video_compose" || tool === "video_plan") {
    composition = args.composition || args;
    mediaMap = args.media || {};
  } else if (tool === "video_edit") {
    // Convert video_edit format → composition-like structure
    composition = convertEditToComposition(args);
    mediaMap = {};
    // video_edit uses media_id referenced via groups segments
    if (args.media) {
      for (const m of args.media) {
        if (m.media_id) mediaMap[m.media_id] = m.url || m.src || "";
      }
    }
  } else if (tool === "video_render_slideshow") {
    composition = convertSlideshowToComposition(args);
    mediaMap = {};
    for (const seg of args.segments || []) {
      if (seg.media_id) mediaMap[seg.media_id] = seg.media_url || "";
    }
  } else if (tool === "video_render_timeline") {
    composition = convertTimelineToComposition(args);
    mediaMap = {};
    for (const seg of args.segments || []) {
      for (const m of seg.media || []) {
        if (m.media_id) mediaMap[m.media_id] = m.url || m.src || "";
      }
    }
  } else if (tool === "video_narrated_scenes") {
    composition = convertNarratedScenesToComposition(args);
    mediaMap = {};
    for (const scene of args.scenes || []) {
      if (scene.media_id) mediaMap[scene.media_id] = scene.media_url || "";
    }
  } else {
    // Fallback: try to use args.composition directly
    composition = args.composition || args;
    mediaMap = args.media || {};
  }

  /* ── Build FableCut project ── */

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

  /* ── Download media and register in FableCut format ── */
  const mediaIdMap = {}; // MCP media_id → FableCut media id

  for (const [mcpId, url] of Object.entries(mediaMap)) {
    if (!url) continue;
    const fableId = "m_" + mcpId;
    const kind = guessKind(url);
    const filename = guessName(url);
    const localPath = path.join(mediaDir, filename);

    // Download if not already present
    if (!fs.existsSync(localPath)) {
      try {
        console.log(`  Downloading media: ${mcpId} → ${filename}`);
        await downloadFile(url, localPath);
      } catch (e) {
        console.warn(`  Failed to download ${url}: ${e.message}`);
        // Register with remote URL as fallback
        project.media.push({
          id: fableId,
          name: filename,
          kind,
          src: url, // remote URL fallback
        });
        mediaIdMap[mcpId] = fableId;
        continue;
      }
    }

    project.media.push({
      id: fableId,
      name: filename,
      kind,
      src: "/media/" + encodeURIComponent(filename),
    });
    mediaIdMap[mcpId] = fableId;
  }

  /* ── Convert tracks/clips ── */
  let clipIdCounter = 0;
  function nextClipId() {
    return "c_mcp" + (clipIdCounter++).toString(36);
  }

  let timelineCursor = 0; // running position on V1

  function processTracks(tracks, layoutOverride) {
    let trackIndex = 0;
    for (const track of tracks) {
      if (!track.clips) continue;
      let localCursor = 0;

      for (const clip of track.clips) {
        const fableClip = convertClip(clip, mediaIdMap, nextClipId, localCursor, trackIndex, layoutOverride);
        if (fableClip) {
          if (Array.isArray(fableClip)) {
            for (const fc of fableClip) {
              project.clips.push(fc);
              localCursor = Math.max(localCursor, (fc.start || 0) + (fc.duration || 0));
            }
          } else {
            project.clips.push(fableClip);
            localCursor = Math.max(localCursor, (fableClip.start || 0) + (fableClip.duration || 0));
          }
        }
      }
      trackIndex++;
    }
  }

  // Process top-level tracks
  if (composition.tracks) {
    // Check for nested composition clips
    for (const track of composition.tracks) {
      if (!track.clips) continue;
      let localCursor = 0;

      for (const clip of track.clips) {
        if (clip.type === "composition") {
          // Nested composition — flatten with layout
          const nestedTracks = clip.tracks || [];
          const layout = clip.layout || "single";
          const positions = layoutToPositions(layout, nestedTracks[0]?.clips?.length || 0);

          // Process nested tracks, applying layout positions to video clips
          let nestedClipIdx = 0;
          for (let ti = 0; ti < nestedTracks.length; ti++) {
            const nt = nestedTracks[ti];
            if (!nt.clips) continue;

            for (const nc of nt.clips) {
              const pos = positions[nestedClipIdx] || { x: 0, y: 0, scale: 1 };
              const fableClips = convertClip(nc, mediaIdMap, nextClipId, localCursor, ti, null, pos);
              if (fableClips) {
                const arr = Array.isArray(fableClips) ? fableClips : [fableClips];
                for (const fc of arr) {
                  project.clips.push(fc);
                }
              }
              nestedClipIdx++;
            }
          }
          // Use a reasonable default duration for the composition
          localCursor += clip.duration === "fit" ? 10 : (clip.duration || 10);
        } else {
          const fableClip = convertClip(clip, mediaIdMap, nextClipId, localCursor, 0);
          if (fableClip) {
            const arr = Array.isArray(fableClip) ? fableClip : [fableClip];
            for (const fc of arr) {
              project.clips.push(fc);
              localCursor = Math.max(localCursor, (fc.start || 0) + (fc.duration || 0));
            }
          }
        }
      }
    }
  }

  // If no clips were added (empty or unrecognized format), add a placeholder
  if (project.clips.length === 0) {
    project.clips.push({
      id: nextClipId(),
      kind: "text",
      mediaId: null,
      track: "V1",
      start: 0,
      duration: 5,
      name: "Import placeholder",
      props: { text: "No clips found in recipe", fontSize: 48, color: "#888888" },
    });
  }

  // Process text overlays from video_edit format
  if (tool === "video_edit" && args.text) {
    for (const overlay of args.text) {
      project.clips.push({
        id: nextClipId(),
        kind: "text",
        mediaId: null,
        track: "V2",
        start: overlay.start || 0,
        duration: overlay.duration || 3,
        name: "overlay",
        props: {
          text: overlay.content || "",
          fontSize: overlay.size || 72,
          color: overlay.color || "#ffffff",
        },
      });
    }
  }

  return project;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Convert a single MCP clip → FableCut clip(s)
   ═══════════════════════════════════════════════════════════════════════════ */

function convertClip(mcpClip, mediaIdMap, nextIdFn, cursor, trackIdx, layoutOverride, position) {
  const type = mcpClip.type;
  const id = nextIdFn();
  const start = mcpClip.start !== undefined ? mcpClip.start : cursor;
  const duration = mcpClip.duration !== undefined
    ? (mcpClip.duration === "fit" ? 5 : mcpClip.duration)
    : 5;

  const pos = position || { x: 0, y: 0, scale: 1 };

  /* VIDEO clip */
  if (type === "video") {
    const mediaId = mediaIdMap[mcpClip.media_id];
    if (!mediaId) return null;
    // MCP uses "in" and "out" (source seconds), or "start" and "duration"
    const inPoint = mcpClip.in !== undefined ? mcpClip.in : (mcpClip.start_in || 0);
    const outPoint = mcpClip.out !== undefined ? mcpClip.out : null;
    const clipDuration = outPoint ? (outPoint - inPoint) : (duration || 5);
    const fableClip = {
      id,
      mediaId,
      kind: "video",
      track: `V${Math.min(trackIdx + 1, 4)}`,
      start,
      in: inPoint,
      duration: clipDuration,
      name: mcpClip.name || "video",
      props: {},
    };
    if (pos.scale !== 1 || pos.x !== 0 || pos.y !== 0) {
      fableClip.props.scale = pos.scale;
      fableClip.props.x = pos.x * 10; // convert percentage-ish to px-ish
      fableClip.props.y = pos.y * 10;
    }
    if (mcpClip.volume !== undefined) fableClip.props.volume = mcpClip.volume;
    if (mcpClip.speed !== undefined) fableClip.props.speed = mcpClip.speed;
    if (mcpClip.muted) fableClip.props.volume = 0;
    return fableClip;
  }

  /* GRAPHIC clip (math, html, manim, chart, etc.) */
  if (type === "graphic") {
    // Graphics need pre-rendering. If the recipe has a media_url for it, use it.
    // Otherwise, create a text placeholder showing what the graphic was.
    const graphicMediaId = mediaIdMap[mcpClip.media_id || mcpClip.id];
    if (graphicMediaId) {
      return {
        id,
        mediaId: graphicMediaId,
        kind: "image",
        track: `V${Math.min(trackIdx + 1, 4)}`,
        start,
        duration,
        name: mcpClip.title || `graphic_${mcpClip.kind}`,
        props: {},
      };
    }
    // Placeholder text clip for the graphic
    const label = mcpClip.kind === "math" ? `📐 ${mcpClip.latex || mcpClip.title || "math"}`
      : mcpClip.kind === "chart" ? "📊 chart"
      : mcpClip.kind === "html" ? "🎨 HTML composition"
      : `🎨 ${mcpClip.kind || "graphic"}`;
    return {
      id,
      kind: "text",
      mediaId: null,
      track: `V${Math.min(trackIdx + 2, 4)}`,
      start,
      duration,
      name: `graphic_${mcpClip.kind || "x"}`,
      props: {
        text: label,
        fontSize: 64,
        color: "#7b6cff",
        align: "center",
        bgColor: "#000000",
        bgOpacity: 0.5,
      },
    };
  }

  /* VOICE clip (TTS narration) */
  if (type === "voice") {
    // Voice clips are TTS — they need pre-rendering to audio files.
    // If we have a media_id pointing to pre-rendered audio, use it.
    const voiceMediaId = mediaIdMap[mcpClip.media_id];
    if (voiceMediaId) {
      return {
        id,
        mediaId: voiceMediaId,
        kind: "audio",
        track: `A${Math.min(trackIdx + 1, 3)}`,
        start,
        duration: mcpClip.duration || 5,
        name: "narration",
        props: { volume: 1 },
      };
    }
    // Fallback: text clip showing what would be narrated
    return {
      id,
      kind: "text",
      mediaId: null,
      track: "V4",
      start,
      duration,
      name: "narration (text only)",
      props: {
        text: `🎙️ ${mcpClip.text || ""}`,
        fontSize: 36,
        color: "#ffd166",
        align: "center",
        bgColor: "#000000",
        bgOpacity: 0.6,
      },
    };
  }

  /* CAPTION clip */
  if (type === "caption") {
    // Captions derive from voice or have explicit text
    let captionText = mcpClip.text || "";
    if (!captionText && mcpClip.from === "voice") {
      // We can't easily extract the voice text here without context,
      // mark it as auto-caption
      captionText = "[caption from voice]";
    }
    return {
      id,
      kind: "text",
      mediaId: null,
      track: "V3",
      start,
      duration,
      name: "caption",
      props: {
        text: captionText,
        fontSize: 72,
        color: "#ffffff",
        align: "center",
        strokeColor: "#000000",
        strokeWidth: 4,
        textAnim: "word-pop",
        bgColor: "#000000",
        bgOpacity: 0.4,
      },
    };
  }

  /* AUDIO clip (background music, sfx) */
  if (type === "audio" || type === "music") {
    const audioMediaId = mediaIdMap[mcpClip.media_id];
    if (!audioMediaId) return null;
    return {
      id,
      mediaId: audioMediaId,
      kind: "audio",
      track: `A${Math.min(trackIdx + 1, 3)}`,
      start,
      duration,
      name: mcpClip.name || "audio",
      props: {
        volume: mcpClip.volume !== undefined ? mcpClip.volume : 0.8,
      },
    };
  }

  /* IMAGE clip */
  if (type === "image") {
    const imgMediaId = mediaIdMap[mcpClip.media_id];
    if (!imgMediaId) return null;
    return {
      id,
      mediaId: imgMediaId,
      kind: "image",
      track: `V${Math.min(trackIdx + 1, 4)}`,
      start,
      duration,
      name: mcpClip.name || "image",
      props: {},
    };
  }

  /* TEXT clip */
  if (type === "text" || type === "title") {
    return {
      id,
      kind: "text",
      mediaId: null,
      track: `V${Math.min(trackIdx + 2, 4)}`,
      start,
      duration,
      name: "text",
      props: {
        text: mcpClip.text || mcpClip.content || "",
        fontSize: mcpClip.fontSize || 72,
        color: mcpClip.color || "#ffffff",
        align: "center",
      },
    };
  }

  /* TRANSITION info — stored as clip metadata */
  if (type === "transition") {
    // Transitions in FableCut are clip properties, not separate clips
    // We'll skip standalone transition clips for now
    return null;
  }

  // Unknown clip type — skip
  return null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Format converters: other MCP tools → composition structure
   ═══════════════════════════════════════════════════════════════════════════ */

function convertEditToComposition(args) {
  // video_edit: groups is array of arrays of segments
  // Convert to a composition with tracks
  const tracks = [];
  const layout = args.layout || "single";

  for (let gi = 0; gi < (args.groups || []).length; gi++) {
    const group = args.groups[gi];
    const clips = [];
    let cursor = 0;
    for (const seg of group) {
      clips.push({
        type: seg.media_id ? "video" : "image",
        media_id: seg.media_id,
        start: cursor,
        duration: (seg.end || 0) - (seg.start || 0) || seg.duration || 5,
        start_in: seg.start || 0,
        volume: seg.volume !== undefined ? seg.volume : (seg.muted ? 0 : 1),
        speed: seg.speed,
        name: `group_${gi}_seg`,
      });
      cursor += clips[clips.length - 1].duration;
    }
    tracks.push({ clips });
  }

  return {
    output: {
      resolution: args.resolution || "landscape",
      fps: args.fps || 30,
    },
    tracks,
    name: args.metadata?.title || "Video Edit Import",
  };
}

function convertSlideshowToComposition(args) {
  const tracks = [{ clips: [] }];
  let cursor = 0;

  for (const seg of args.segments || []) {
    tracks[0].clips.push({
      type: "image",
      media_id: seg.media_id,
      start: cursor,
      duration: seg.duration_seconds || 5,
      name: "slide",
    });
    // Add text overlay as separate track clip
    if (seg.text) {
      if (!tracks[1]) tracks[1] = { clips: [] };
      tracks[1].clips.push({
        type: "text",
        text: seg.text,
        start: cursor,
        duration: seg.duration_seconds || 5,
      });
    }
    cursor += seg.duration_seconds || 5;
  }

  return {
    output: {
      resolution: args.resolution || "landscape",
      fps: args.fps || 30,
    },
    tracks,
    name: args.metadata?.title || "Slideshow Import",
  };
}

function convertTimelineToComposition(args) {
  const tracks = [{ clips: [] }];
  let cursor = 0;

  for (const seg of args.segments || []) {
    // Each segment has media (video clips) + html (composition)
    for (const m of seg.media || []) {
      tracks[0].clips.push({
        type: "video",
        media_id: m.media_id,
        start: cursor,
        duration: seg.duration || 5,
        name: "timeline_seg",
      });
    }
    cursor += seg.duration || 5;
  }

  return {
    output: {
      resolution: args.resolution || "landscape",
      fps: args.fps || 30,
    },
    tracks,
    name: args.metadata?.title || "Timeline Import",
  };
}

function convertNarratedScenesToComposition(args) {
  const tracks = [
    { clips: [] }, // video
    { clips: [] }, // voice/narration
    { clips: [] }, // captions
  ];
  let cursor = 0;

  for (const scene of args.scenes || []) {
    const sceneDuration = 5; // estimated — real duration from TTS

    // Visual
    if (scene.media_id) {
      tracks[0].clips.push({
        type: "video",
        media_id: scene.media_id,
        start: cursor,
        duration: sceneDuration,
        name: "scene",
      });
    } else if (scene.math) {
      tracks[0].clips.push({
        type: "graphic",
        kind: "math",
        latex: scene.math.latex,
        title: scene.math.title || "math",
        start: cursor,
        duration: sceneDuration,
      });
    }

    // Narration
    if (scene.line) {
      tracks[1].clips.push({
        type: "voice",
        text: scene.line,
        start: cursor,
        duration: sceneDuration,
      });
      // Caption from narration
      tracks[2].clips.push({
        type: "caption",
        text: scene.line,
        from: "voice",
        start: cursor,
        duration: sceneDuration,
      });
    }

    cursor += sceneDuration;
  }

  const resKey = args.resolution || "landscape";

  return {
    output: {
      resolution: resKey,
      fps: 30,
      tail_sec: args.tail_sec || 0.6,
    },
    tracks,
    name: args.metadata?.title || "Narrated Scenes Import",
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   Main export: fetch + convert + return project
   ═══════════════════════════════════════════════════════════════════════════ */

async function importMcpProject(projectId, mediaDir) {
  const recipeUrl = `${MCP_BASE_URL}/${projectId}.json`;
  console.log(`[MCP Import] Fetching recipe: ${recipeUrl}`);

  let recipe = await fetchJSON(recipeUrl);
  // The public bucket wraps the recipe under a "recipe" key with metadata
  if (recipe.recipe && recipe.recipe.tool) {
    recipe = recipe.recipe;
  }
  console.log(`[MCP Import] Recipe tool: ${recipe.tool || "unknown"}`);

  const project = await convertRecipe(recipe, mediaDir);
  project.revision = 1;
  project.name = `${projectId} — MCP Import`;

  console.log(`[MCP Import] Converted: ${project.clips.length} clips, ${project.media.length} media`);
  return { project, recipe };
}

module.exports = {
  importMcpProject,
  convertRecipe,
  fetchJSON,
  downloadFile,
};
