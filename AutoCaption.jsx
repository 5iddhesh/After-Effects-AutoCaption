/*
  AutoCaption (version: see VERSION below)
  Word-accurate auto captions for After Effects. API transcription only
  (Groq / OpenAI Whisper - needs an API key). Two stages:
    1. Transcribe & Mark  -> one marker per word on selected audio layer  [LIVE]
    2. Generate Captions  -> plain styled text layers from markers        [LIVE]
  Markers are the source of truth: hand-fix words/timing on the layer, then
  re-generate. Optional text-animation presets (captured from hand-animated
  titles) apply per caption layer via the Text animation dropdown. Generated layers carry comment "AutoCaption" and are replaced
  on every generate.
  Core functions live on $.global.AutoCaptionCore for headless testing.
  Set $.global.AC_CORE_ONLY = true before evalFile to skip UI build.
*/

(function autoCaption(thisObj) {

    var SCRIPT_NAME = "AutoCaption";
    var VERSION = "2.0";

    // ================= CORE =================

    var AC = {};
    $.global.AutoCaptionCore = AC;
    AC.VERSION = VERSION;

    // ---- tool paths (first existing candidate wins) ----

    function firstExisting(paths) {
        for (var i = 0; i < paths.length; i++) {
            if (new File(paths[i]).exists) return paths[i];
        }
        return null;
    }

    AC.paths = {
        ffmpeg: firstExisting(["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]),
        python: firstExisting(["/usr/bin/python3", "/opt/homebrew/bin/python3"]),
        curl: "/usr/bin/curl"
    };

    AC.workDir = function () {
        var d = new Folder(Folder.temp.fsName + "/autocaption");
        if (!d.exists) d.create();
        return d.fsName;
    };

    // ---- shell ----

    function bashQuote(s) { return "'" + s.replace(/'/g, "'\\''") + "'"; }

    AC.shell = function (cmd) {
        var work = AC.workDir();
        var log = work + "/run.log";
        var full = 'export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"; '
                 + "{ " + cmd + " ; } > " + bashQuote(log) + " 2>&1; echo EXIT:$?";
        var out = system.callSystem("/bin/bash -c " + bashQuote(full));
        var m = /EXIT:(\d+)/.exec(out || "");
        return { code: m ? parseInt(m[1], 10) : -1, log: log };
    };

    AC.readFile = function (path) {
        var f = new File(path);
        if (!f.exists || !f.open("r")) return null;
        f.encoding = "UTF-8";
        var t = f.read(); f.close();
        return t;
    };

    AC.tailLog = function (logPath, n) {
        var t = AC.readFile(logPath) || "";
        var lines = t.split(/\r?\n/);
        return lines.slice(Math.max(0, lines.length - (n || 4))).join(" | ");
    };

    // ---- flatten.py: whisperx/verbose_json -> word TSV ----

    AC.writeFlattenPy = function () {
        var p = AC.workDir() + "/flatten.py";
        var code = ""
            + "import json, sys\n"
            + "d = json.load(open(sys.argv[1]))\n"
            + "words = []\n"
            + "if isinstance(d.get('words'), list) and d['words']:\n"
            + "    words = d['words']\n"
            + "else:\n"
            + "    for s in d.get('segments', []):\n"
            + "        words += s.get('words', [])\n"
            + "out = open(sys.argv[2], 'w')\n"
            + "last_end = 0.0\n"
            + "for w in words:\n"
            + "    word = (w.get('word') or '').strip()\n"
            + "    if not word: continue\n"
            + "    st = w.get('start'); en = w.get('end')\n"
            + "    if st is None: st = last_end\n"
            + "    if en is None: en = st\n"
            + "    last_end = en\n"
            + "    out.write('%s\\t%.4f\\t%.4f\\n' % (word, st, en))\n"
            + "out.close()\n";
        var f = new File(p);
        f.encoding = "UTF-8";
        f.open("w"); f.write(code); f.close();
        return p;
    };

    // ---- transcription engines (return TSV path or {err}) ----

    AC.extractAudio = function (srcPath) {
        if (!AC.paths.ffmpeg) return { err: "ffmpeg not found." };
        var wav = AC.workDir() + "/audio.wav";
        var r = AC.shell(bashQuote(AC.paths.ffmpeg) + " -y -i " + bashQuote(srcPath)
            + " -vn -ar 16000 -ac 1 " + bashQuote(wav));
        if (r.code !== 0) return { err: "ffmpeg failed: " + AC.tailLog(r.log, 2) };
        return { wav: wav };
    };

    AC.transcribeAPI = function (srcPath, provider, apiKey, language) {
        if (!apiKey) return { err: "No API key set." };
        var ex = AC.extractAudio(srcPath);
        if (ex.err) return ex;
        var work = AC.workDir();
        var json = work + "/api.json";
        new File(json).remove();
        var url, model;
        if (provider === "OpenAI") {
            url = "https://api.openai.com/v1/audio/transcriptions";
            model = "whisper-1";   // OpenAI has no large-v3-turbo
        } else {
            url = "https://api.groq.com/openai/v1/audio/transcriptions";
            model = "whisper-large-v3-turbo";
        }
        var cmd = bashQuote(AC.paths.curl) + " -s " + bashQuote(url)
            + " -H " + bashQuote("Authorization: Bearer " + apiKey)
            + " -F file=@" + bashQuote(ex.wav)
            + " -F model=" + model
            + " -F response_format=verbose_json"
            + " -F " + bashQuote("timestamp_granularities[]=word")
            + " -o " + bashQuote(json)
            + " -w " + bashQuote("HTTP:%{http_code}");
        if (language && language !== "auto") cmd += " -F language=" + language;
        var r = AC.shell(cmd);
        var body = AC.readFile(json) || "";
        var m = /HTTP:(\d+)/.exec(AC.readFile(r.log) || "");
        var http = m ? m[1] : "?";
        if (r.code !== 0 || http !== "200" || body.indexOf('"text"') < 0) {
            var hint = body.replace(/\s+/g, " ").substr(0, 220);
            return { err: provider + " API HTTP " + http + ": " + (hint || AC.tailLog(r.log, 2)) };
        }
        return AC.flatten(json);
    };

    AC.flatten = function (jsonPath) {
        if (!AC.paths.python) return { err: "python3 not found." };
        var py = AC.writeFlattenPy();
        var tsv = AC.workDir() + "/words.tsv";
        new File(tsv).remove();
        var r = AC.shell(bashQuote(AC.paths.python) + " " + bashQuote(py) + " "
            + bashQuote(jsonPath) + " " + bashQuote(tsv));
        if (r.code !== 0 || !new File(tsv).exists)
            return { err: "flatten failed: " + AC.tailLog(r.log, 2) };
        return { tsv: tsv };
    };

    // ---- words + markers ----

    AC.readWords = function (tsvPath) {
        var raw = AC.readFile(tsvPath);
        if (raw === null) return null;
        var words = [];
        var lines = raw.split(/\r?\n/);
        for (var i = 0; i < lines.length; i++) {
            if (!lines[i]) continue;
            var p = lines[i].split("\t");
            if (p.length < 3) continue;
            words.push({ word: p[0], start: parseFloat(p[1]), end: parseFloat(p[2]) });
        }
        return words;
    };

    AC.stripPunct = function (w) {
        return w.replace(/^[\.,!\?;:"\(\)\[\]]+/, "").replace(/[\.,!\?;:"\(\)\[\]]+$/, "");
    };

    // Marker times are in LAYER time: markers ride the layer, so they stay on
    // the spoken word even if the layer is moved later. Word source time maps
    // through the layer's stretch.
    AC.addWordMarkers = function (layer, words, opts) {
        opts = opts || {};
        var comp = layer.containingComp;
        var frameDur = comp.frameDuration;
        var stretch = layer.stretch / 100;
        var mk = layer.property("Marker");
        app.beginUndoGroup("AutoCaption: Word Markers");
        try {
            if (opts.clearFirst !== false)
                for (var k = mk.numKeys; k >= 1; k--) mk.removeKey(k);
            var prevT = -1, added = 0;
            for (var i = 0; i < words.length; i++) {
                var w = opts.stripPunct ? AC.stripPunct(words[i].word) : words[i].word;
                if (!w) continue;
                var t = words[i].start * stretch;
                if (opts.snapToFrame) t = Math.round(t / frameDur) * frameDur;
                if (t <= prevT) t = prevT + 0.001;   // markers can't share a time
                prevT = t;
                var mv = new MarkerValue(w);
                mv.duration = Math.max(0, (words[i].end - words[i].start) * stretch);
                mk.setValueAtTime(t, mv);
                added++;
            }
            return { added: added };
        } catch (e) {
            return { err: "marker write failed line " + e.line + ": " + e.toString() };
        } finally {
            app.endUndoGroup();
        }
    };

    AC.clearMarkers = function (layer) {
        var mk = layer.property("Marker");
        var n = mk.numKeys;
        app.beginUndoGroup("AutoCaption: Clear Markers");
        for (var i = n; i >= 1; i--) mk.removeKey(i);
        app.endUndoGroup();
        return n;
    };

    // ---- SRT import (segment or word-per-cue files) ----

    AC.parseSRT = function (path) {
        var raw = AC.readFile(path);
        if (raw === null) return null;
        var words = [];
        var blocks = raw.split(/\r?\n\r?\n/);
        var timeRe = /(\d+):(\d+):(\d+)[,\.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,\.](\d+)/;
        for (var i = 0; i < blocks.length; i++) {
            var lines = blocks[i].split(/\r?\n/);
            for (var j = 0; j < lines.length; j++) {
                var m = timeRe.exec(lines[j]);
                if (!m) continue;
                var st = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
                var en = (+m[5]) * 3600 + (+m[6]) * 60 + (+m[7]) + (+m[8]) / 1000;
                var text = lines.slice(j + 1).join(" ").replace(/<[^>]+>/g, "").replace(/^\s+|\s+$/g, "");
                if (text) words.push({ word: text, start: st, end: en });
                break;
            }
        }
        return words;
    };

    // ---- full stage-1 pipeline ----

    AC.resolveSourceFile = function (layer) {
        if (layer.source && layer.source.file) return layer.source.file.fsName;
        return null;
    };

    AC.transcribeAndMark = function (layer, cfg) {
        var src = cfg.srcOverride || AC.resolveSourceFile(layer);
        if (!src) return { err: "Layer has no source file (precomp audio: pick file manually)." };
        var t = AC.transcribeAPI(src, cfg.provider, cfg.apiKey, cfg.language);
        if (t.err) return t;
        var words = AC.readWords(t.tsv);
        if (!words || words.length === 0) return { err: "No words returned (silent audio?)." };
        var r = AC.addWordMarkers(layer, words, cfg);
        if (r.err) return r;
        r.words = words.length;
        return r;
    };

    // ---- installed font catalog (app.fonts, AE 24+) ----
    // Returns [{ name: familyName, styles: [{ style, ps }] }], sorted by family.
    AC.fontCatalog = function () {
        var cat = [];
        try {
            var groups = app.fonts.allFonts;
            for (var i = 0; i < groups.length; i++) {
                var fam = groups[i];
                if (!fam || !fam.length) continue;
                var entry = { name: fam[0].familyName, styles: [] };
                for (var j = 0; j < fam.length; j++)
                    entry.styles.push({ style: fam[j].styleName, ps: fam[j].postScriptName });
                cat.push(entry);
            }
            cat.sort(function (a, b) {
                var x = ("" + a.name).toLowerCase(), y = ("" + b.name).toLowerCase();
                return x < y ? -1 : (x > y ? 1 : 0);
            });
        } catch (e) {}
        return cat;
    };

    // ================= GENERATOR (stage 2) =================

    AC.hexToRgb = function (hex) {
        hex = ("" + hex).replace(/[^0-9a-fA-F]/g, "");
        if (hex.length === 3)
            hex = hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2);
        if (hex.length !== 6) return [1, 1, 1];
        return [parseInt(hex.substr(0, 2), 16) / 255,
                parseInt(hex.substr(2, 2), 16) / 255,
                parseInt(hex.substr(4, 2), 16) / 255];
    };

    // Markers (layer time) -> words in COMP time.
    AC.readMarkers = function (layer) {
        var mk = layer.property("Marker");
        var words = [];
        for (var k = 1; k <= mk.numKeys; k++) {
            var t = layer.startTime + mk.keyTime(k);
            var v = mk.keyValue(k);
            var w = v.comment.replace(/^\s+|\s+$/g, "");
            if (!w) continue;
            words.push({ word: w, start: t, end: t + Math.max(0.12, v.duration) });
        }
        return words;
    };

    AC.chunkWords = function (words, opts) {
        var maxW = Math.max(1, Math.round(opts.wordsPerScreen || 3));
        var chunks = [], cur = [];
        for (var i = 0; i < words.length; i++) {
            cur.push(words[i]);
            var brk = (cur.length >= maxW);
            if (!brk && opts.smartChunk) {
                if (/[\.!\?,;:]$/.test(words[i].word)) brk = true;
                var nx = words[i + 1];
                if (nx && (nx.start - words[i].end) > 0.6) brk = true;
            }
            if (brk) { chunks.push(cur); cur = []; }
        }
        if (cur.length) chunks.push(cur);
        return chunks;
    };

    AC.removeGenerated = function (comp) {
        var n = 0;
        for (var i = comp.numLayers; i >= 1; i--) {
            if (comp.layer(i).comment === "AutoCaption") { comp.layer(i).remove(); n++; }
        }
        return n;
    };

    AC.buildTextLayer = function (comp, chunk, S, idx, inT, outT) {
        var txt = [];
        for (var i = 0; i < chunk.length; i++) txt.push(chunk[i].word);
        var capText = txt.join(" ");
        var tl = comp.layers.addText(capText);
        tl.name = capText.length > 60 ? capText.substr(0, 57) + "..." : capText;
        tl.comment = "AutoCaption";
        tl.label = 9;
        var st = tl.property("ADBE Text Properties").property("ADBE Text Document");
        var td = st.value;
        td.resetCharStyle();
        td.font = S.fontName;
        td.fontSize = S.fontSize;
        td.applyFill = true;
        td.fillColor = AC.hexToRgb(S.fillHex);
        if (S.strokeWidth > 0) {
            td.applyStroke = true;
            td.strokeColor = AC.hexToRgb(S.strokeHex);
            td.strokeWidth = S.strokeWidth;
            td.strokeOverFill = false;
        } else {
            td.applyStroke = false;
        }
        if (S.tracking) td.tracking = S.tracking;
        td.justification = ParagraphJustification.CENTER_JUSTIFY;
        st.setValue(td);
        var pctMap = { Bottom: 85, Center: 50, Top: 12 };
        var pct = (S.placement === "Custom") ? S.customY : pctMap[S.placement];
        if (pct === undefined || isNaN(pct)) pct = 85;
        tl.property("ADBE Transform Group").property("ADBE Position")
          .setValue([comp.width / 2, comp.height * pct / 100]);
        tl.inPoint = inT;
        tl.outPoint = outT;
        return tl;
    };

    function timesArr(chunk, key) {
        var a = [];
        for (var i = 0; i < chunk.length; i++) a.push(chunk[i][key].toFixed(4));
        return "[" + a.join(",") + "]";
    }

    function amountProp(sel) {
        var amt = null;
        try { amt = sel.property("ADBE Text Expressible Amount"); } catch (e0) {}
        if (!amt) try { amt = sel.property("ADBE Text Selector Max Amount"); } catch (e1) {}
        if (!amt) {
            for (var i = 1; i <= sel.numProperties; i++)
                if (sel.property(i).name === "Amount") { amt = sel.property(i); break; }
        }
        return amt;
    }

    function addExprSelector(anim, expr) {
        var sel = anim.property("ADBE Text Selectors").addProperty("ADBE Text Expressible Selector");
        try { sel.property("ADBE Text Range Type2").setValue(3); } catch (e) {}  // based on: words
        var amt = amountProp(sel);
        if (amt) amt.expression = expr;
        return sel;
    }

    // Spoken-word highlight: fill color driven by an expression selector
    // keyed to the chunk's word times (comp time).
    AC.addHighlightAnimator = function (tl, chunk, S) {
        if (!S.highlightOn) return;
        var anim = tl.property("ADBE Text Properties").property("ADBE Text Animators")
                     .addProperty("ADBE Text Animator");
        anim.name = "AC Highlight";
        anim.property("ADBE Text Animator Properties")
            .addProperty("ADBE Text Fill Color").setValue(AC.hexToRgb(S.highlightHex));
        addExprSelector(anim,
            "var st = " + timesArr(chunk, "start") + ";\n"
          + "var en = " + timesArr(chunk, "end") + ";\n"
          + "var i = textIndex - 1;\n"
          + "(time >= st[i] && time < en[i]) ? 100 : 0;");
    };

    // ---- text animation presets ----
    // Captured 2026-06-10 from the user's hand-animated titles in "Comp 2"
    // (range-selector sweep with ramp-up shape, ease high -50 / low 100,
    // animator opacity 0 plus optional position offset; flicker = layer
    // opacity keys with random(value,100)). Listed in timeline order.
    AC.ANIM_PRESETS = [
        { name: "Rise Up (Words)",      basedOn: 3, pos: [0, 100, 0] },  // "In the beginning."
        { name: "Slide In (Words)",     basedOn: 3, pos: [100, 0, 0] },  // "There was only an idea."
        { name: "Flicker In",           flicker: true },                 // "A small team."
        { name: "Rise Up (Characters)", basedOn: 1, pos: [0, 100, 0] },  // "A single room."
        { name: "Fade In (Words)",      basedOn: 3, pos: null }          // "And an impossible deadline."
    ];

    // The captured titles sweep the reveal across their whole duration;
    // captions can sit on screen longer, so the sweep is capped at 1.2s.
    AC.addAnimPreset = function (tl, S) {
        if (!S.animOn) return;
        var P = null;
        for (var i = 0; i < AC.ANIM_PRESETS.length; i++)
            if (AC.ANIM_PRESETS[i].name === S.animPreset) { P = AC.ANIM_PRESETS[i]; break; }
        if (!P) return;
        var inT = tl.inPoint, layerDur = tl.outPoint - tl.inPoint;
        if (P.flicker) {
            var op = tl.property("ADBE Transform Group").property("ADBE Opacity");
            var fd = Math.min(0.48, layerDur * 0.5);
            op.setValueAtTime(inT, 0);
            op.setValueAtTime(inT + fd, 100);
            op.expression = "random(value,100)";
            return;
        }
        var dur = Math.min(layerDur * 0.8, 1.2);
        var anim = tl.property("ADBE Text Properties").property("ADBE Text Animators")
                     .addProperty("ADBE Text Animator");
        anim.name = "AC Anim";
        var props = anim.property("ADBE Text Animator Properties");
        props.addProperty("ADBE Text Opacity").setValue(0);
        if (P.pos) props.addProperty("ADBE Text Position 3D").setValue(P.pos);
        var sel = anim.property("ADBE Text Selectors").addProperty("ADBE Text Selector");
        var adv = sel.property("ADBE Text Range Advanced");
        try { adv.property("ADBE Text Range Type2").setValue(P.basedOn); } catch (e1) {}
        try { adv.property("ADBE Text Range Shape").setValue(2); } catch (e2) {}      // ramp up
        try { adv.property("ADBE Text Levels Max Ease").setValue(-50); } catch (e3) {}
        try { adv.property("ADBE Text Levels Min Ease").setValue(100); } catch (e4) {}
        var off = sel.property("ADBE Text Percent Offset");
        off.setValueAtTime(inT, -100);
        off.setValueAtTime(inT + dur, 100);
    };

    // Re-apply current panel style (font/size/tracking/colors) to a text layer.
    AC.restyle = function (tl, S) {
        var st = tl.property("ADBE Text Properties").property("ADBE Text Document");
        var td = st.value;
        td.font = S.fontName;
        td.fontSize = S.fontSize;
        td.tracking = S.tracking;
        td.applyFill = true;
        td.fillColor = AC.hexToRgb(S.fillHex);
        if (S.strokeWidth > 0) {
            td.applyStroke = true;
            td.strokeColor = AC.hexToRgb(S.strokeHex);
            td.strokeWidth = S.strokeWidth;
            td.strokeOverFill = false;
        } else {
            td.applyStroke = false;
        }
        st.setValue(td);
        var anims = tl.property("ADBE Text Properties").property("ADBE Text Animators");
        for (var i = 1; i <= anims.numProperties; i++)
            if (anims.property(i).name === "AC Highlight") {
                anims.property(i).property("ADBE Text Animator Properties")
                     .property("ADBE Text Fill Color").setValue(AC.hexToRgb(S.highlightHex));
                anims.property(i).enabled = (S.highlightOn !== false);
            }
    };

    // Strip a previously applied preset (AC Anim animator or flicker keys).
    AC.clearAnim = function (tl) {
        var anims = tl.property("ADBE Text Properties").property("ADBE Text Animators");
        for (var i = anims.numProperties; i >= 1; i--)
            if (anims.property(i).name === "AC Anim") anims.property(i).remove();
        var op = tl.property("ADBE Transform Group").property("ADBE Opacity");
        if (op.expression === "random(value,100)") {
            op.expression = "";
            while (op.numKeys) op.removeKey(1);
            op.setValue(100);
        }
    };

    // ---- full stage-2 pipeline ----

    AC.generateCaptions = function (layer, S) {
        var comp = layer.containingComp;
        var words = AC.readMarkers(layer);
        if (!words.length) return { err: "No word markers on layer. Run step 1 first." };
        app.beginUndoGroup("AutoCaption: Generate Captions");
        try {
            var removed = AC.removeGenerated(comp);
            var chunks = AC.chunkWords(words, S);
            var made = 0;
            for (var c = 0; c < chunks.length; c++) {
                var ch = chunks[c];
                var inT = ch[0].start;
                if (inT >= comp.duration) break;
                var lastEnd = ch[ch.length - 1].end;
                var outT;
                var nx = chunks[c + 1];
                if (nx && (nx[0].start - lastEnd) < 0.8) outT = nx[0].start;
                else outT = lastEnd + 0.35;
                outT = Math.min(outT, comp.duration);
                if (outT <= inT + 0.1) outT = inT + 0.1;
                var tl = AC.buildTextLayer(comp, ch, S, c, inT, outT);
                AC.addHighlightAnimator(tl, ch, S);
                AC.addAnimPreset(tl, S);
                made++;
            }
            return { layers: made, chunks: chunks.length, cleared: removed };
        } catch (e) {
            return { err: "generate failed line " + e.line + ": " + e.toString() };
        } finally {
            app.endUndoGroup();
        }
    };

    // ================= SETTINGS =================

    var DEFAULTS = {
        provider: "Groq", keyGroq: "", keyOpenAI: "",
        language: "auto",
        snapToFrame: false, stripPunct: false,
        placement: "Bottom", customY: 85,
        wordsPerScreen: 3, smartChunk: true,
        fontName: "Montserrat-Bold", fontSize: 80,
        tracking: 0,
        fillHex: "FFFFFF", strokeHex: "000000", strokeWidth: 0,
        highlightOn: true, highlightHex: "FFD60A",
        animOn: true, animPreset: "Rise Up (Words)"
    };
    AC.DEFAULTS = DEFAULTS;

    function settingsFile() {
        var dir = new Folder(Folder.userData.fsName + "/AutoCaption");
        if (!dir.exists) dir.create();
        return new File(dir.fsName + "/settings.json");
    }

    function serialize(obj) {
        var parts = [];
        for (var k in obj) {
            if (!obj.hasOwnProperty(k)) continue;
            var v = obj[k];
            if (typeof v === "string")
                v = '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
            parts.push('"' + k + '":' + v);
        }
        return "{" + parts.join(",") + "}";
    }

    function parseJSONLoose(str) {
        if (!/^[\s\{\}\[\]:,"0-9a-zA-Z_\.\-\\\/\+#%\(\)'@ ]*$/.test(str)) return null;
        try { return eval("(" + str + ")"); } catch (e) { return null; }
    }

    function loadSettings() {
        var s = {}, k;
        for (k in DEFAULTS) s[k] = DEFAULTS[k];
        var f = settingsFile();
        if (f.exists && f.open("r")) {
            var raw = f.read(); f.close();
            var saved = parseJSONLoose(raw);
            if (saved) {
                for (k in saved) if (s.hasOwnProperty(k)) s[k] = saved[k];
                // migrate pre-1.4 single apiKey into the per-provider slot
                // (skip sk-or-* OpenRouter keys - wrong service, can never work)
                if (saved.apiKey && !s.keyGroq && !s.keyOpenAI && !/^sk-or-/.test(saved.apiKey)) {
                    if (s.provider === "OpenAI") s.keyOpenAI = saved.apiKey;
                    else s.keyGroq = saved.apiKey;
                }
            }
        }
        return s;
    }

    function saveSettings(s) {
        var f = settingsFile();
        f.encoding = "UTF-8";
        if (f.open("w")) { f.write(serialize(s)); f.close(); return true; }
        return false;
    }

    var S = loadSettings();

    function getSelectedLayer() {
        var comp = app.project ? app.project.activeItem : null;
        if (!(comp && comp instanceof CompItem)) return { err: "No active composition." };
        if (comp.selectedLayers.length !== 1) return { err: "Select exactly one audio/video layer." };
        var layer = comp.selectedLayers[0];
        if (!layer.hasAudio) return { err: "Selected layer has no audio." };
        return { comp: comp, layer: layer };
    }

    // ================= UI =================

    function buildUI(thisObj) {
        var win = (thisObj instanceof Panel)
            ? thisObj
            : new Window("palette", SCRIPT_NAME + " v" + VERSION, undefined, { resizeable: true });

        win.orientation = "column";
        win.alignChildren = ["fill", "top"];
        win.spacing = 6;
        win.margins = 10;

        var stTitle = win.add("statictext", undefined, SCRIPT_NAME + " V" + VERSION);
        stTitle.alignment = ["center", "top"];
        try { stTitle.graphics.font = ScriptUI.newFont(stTitle.graphics.font.name, "BOLD", 14); } catch (eT) {}

        function row(parent) {
            var g = parent.add("group");
            g.orientation = "row";
            g.alignChildren = ["left", "center"];
            g.spacing = 6;
            return g;
        }

        // small clickable color swatch + hex field, opens the system color picker
        function addColorControl(parent, label, initHex) {
            parent.add("statictext", undefined, label);
            var sw = parent.add("group");
            sw.preferredSize = [26, 18];
            var et = parent.add("edittext", undefined, ("" + initHex).replace("#", "")); et.characters = 7;
            sw.onDraw = function () {
                try {
                    var g = this.graphics;
                    var rgb = AC.hexToRgb(et.text);
                    g.rectPath(0, 0, this.size[0], this.size[1]);
                    g.fillPath(g.newBrush(g.BrushType.SOLID_COLOR, [rgb[0], rgb[1], rgb[2], 1]));
                } catch (eD) {}
            };
            function repaint() { sw.visible = false; sw.visible = true; }
            sw.addEventListener("mousedown", function () {
                var cur = parseInt(et.text.replace("#", ""), 16);
                if (isNaN(cur)) cur = 0xFFFFFF;
                var c = $.colorPicker(cur);
                if (c !== -1) {
                    var h = c.toString(16);
                    while (h.length < 6) h = "0" + h;
                    et.text = h.toUpperCase();
                    repaint();
                }
            });
            et.onChange = repaint;
            return { et: et, swatch: sw };
        }

        // ===== 1. TRANSCRIBE =====
        var pSrc = win.add("panel", undefined, "Transcribe to Word Markers");
        pSrc.orientation = "column"; pSrc.alignChildren = ["fill", "top"]; pSrc.margins = 10; pSrc.spacing = 6;

        // --- API key: ask once, then hide behind "Edit Key..." ---
        var gKeyStack = pSrc.add("group");
        gKeyStack.orientation = "stack";
        gKeyStack.alignChildren = ["fill", "top"];

        var gApi = gKeyStack.add("group");
        gApi.orientation = "row"; gApi.alignChildren = ["left", "center"]; gApi.spacing = 6;
        gApi.add("statictext", undefined, "Provider:");
        var ddProvider = gApi.add("dropdownlist", undefined, ["Groq", "OpenAI"]);
        ddProvider.selection = (S.provider === "OpenAI") ? 1 : 0;
        gApi.add("statictext", undefined, "API key:");
        var etKey = gApi.add("edittext", undefined, "", { properties: { noecho: true } });
        etKey.characters = 16;
        var btnSaveKey = gApi.add("button", undefined, "Save");

        var gKeyDone = gKeyStack.add("group");
        gKeyDone.orientation = "row"; gKeyDone.alignChildren = ["left", "center"]; gKeyDone.spacing = 6;
        var stKeyInfo = gKeyDone.add("statictext", undefined, "");
        stKeyInfo.preferredSize.width = 240;
        var btnEditKey = gKeyDone.add("button", undefined, "Edit Key...");

        function provName() { return ddProvider.selection ? ddProvider.selection.text : "Groq"; }
        function keyFor(p) { return p === "OpenAI" ? S.keyOpenAI : S.keyGroq; }
        function setKeyFor(p, v) { if (p === "OpenAI") S.keyOpenAI = v; else S.keyGroq = v; }

        function syncKeyUI() {
            var has = !!keyFor(S.provider);
            gApi.visible = !has;
            gKeyDone.visible = has;
            stKeyInfo.text = has ? ("API key saved (" + S.provider + ")") : "";
            if (win.layout) try { win.layout.layout(true); } catch (e) {}
        }

        ddProvider.onChange = function () { etKey.text = keyFor(provName()); };
        btnSaveKey.onClick = function () {
            var v = etKey.text.replace(/^\s+|\s+$/g, "");
            if (!v) { status("Paste a key first."); return; }
            S.provider = provName();
            setKeyFor(S.provider, v);
            saveSettings(S);
            syncKeyUI();
            status(S.provider + " key saved.");
        };
        btnEditKey.onClick = function () {
            ddProvider.selection = (S.provider === "OpenAI") ? 1 : 0;
            etKey.text = keyFor(S.provider);
            gApi.visible = true;
            gKeyDone.visible = false;
            if (win.layout) try { win.layout.layout(true); } catch (e) {}
        };

        var LANGS = [
            { label: "Auto-detect", code: "auto" },
            { label: "English", code: "en" },
            { label: "\u0939\u093F\u0928\u094D\u0926\u0940 (Hindi)", code: "hi" },
            { label: "\u092E\u0930\u093E\u0920\u0940 (Marathi)", code: "mr" },
            { label: "Espa\u00F1ol (Spanish)", code: "es" },
            { label: "Fran\u00E7ais (French)", code: "fr" },
            { label: "Deutsch (German)", code: "de" }
        ];
        var gLang = row(pSrc);
        gLang.add("statictext", undefined, "Language:");
        var langLabels = [];
        for (var li0 = 0; li0 < LANGS.length; li0++) langLabels.push(LANGS[li0].label);
        var ddLang = gLang.add("dropdownlist", undefined, langLabels);
        ddLang.selection = 0;
        for (var li = 0; li < LANGS.length; li++)
            if (LANGS[li].code === S.language) ddLang.selection = li;

        var gOpts = row(pSrc);
        var cbSnap = gOpts.add("checkbox", undefined, "Snap markers to frames");
        cbSnap.value = S.snapToFrame;
        var cbPunct = gOpts.add("checkbox", undefined, "Strip punctuation");
        cbPunct.value = S.stripPunct;

        var gBtns1 = row(pSrc);
        var btnTranscribe = gBtns1.add("button", undefined, "Transcribe & Mark Words");
        btnTranscribe.preferredSize.width = 200;
        var btnImport = gBtns1.add("button", undefined, "Import SRT/JSON...");
        var btnClear = gBtns1.add("button", undefined, "Clear Markers");

        // ===== 2. CAPTION STYLE =====
        var pCap = win.add("panel", undefined, "Generate Captions");
        pCap.orientation = "column"; pCap.alignChildren = ["fill", "top"]; pCap.margins = 10; pCap.spacing = 6;

        var gPlace = row(pCap);
        gPlace.add("statictext", undefined, "Placement:");
        var ddPlace = gPlace.add("dropdownlist", undefined, ["Bottom", "Center", "Top", "Custom"]);
        ddPlace.selection = 0;
        for (var pi = 0; pi < ddPlace.items.length; pi++)
            if (ddPlace.items[pi].text === S.placement) ddPlace.selection = pi;
        gPlace.add("statictext", undefined, "Y %:");
        var etY = gPlace.add("edittext", undefined, "" + S.customY); etY.characters = 4;

        var gChunk = row(pCap);
        gChunk.add("statictext", undefined, "Words / screen:");
        var slWords = gChunk.add("slider", undefined, S.wordsPerScreen, 1, 8);
        slWords.preferredSize.width = 100;
        var stWords = gChunk.add("statictext", undefined, "" + S.wordsPerScreen);
        slWords.onChanging = function () { stWords.text = "" + Math.round(slWords.value); };
        var cbSmart = gChunk.add("checkbox", undefined, "Smart chunk (punct + pauses)");
        cbSmart.value = S.smartChunk;

        var CAT = AC.fontCatalog();
        var gFont = row(pCap);
        var ddFamily = null, ddStyle = null, etFont = null;
        if (CAT.length) {
            var famNames = [];
            for (var fi = 0; fi < CAT.length; fi++) famNames.push(CAT[fi].name);
            gFont.add("statictext", undefined, "Font:");
            ddFamily = gFont.add("dropdownlist", undefined, famNames);
            ddFamily.preferredSize.width = 170;
            gFont.add("statictext", undefined, "Style:");
            ddStyle = gFont.add("dropdownlist", undefined, []);
            ddStyle.preferredSize.width = 110;

            var fillStyles = function (famIdx, wantPs) {
                ddStyle.removeAll();
                var sts = CAT[famIdx].styles;
                var selIdx = 0;
                for (var si = 0; si < sts.length; si++) {
                    ddStyle.add("item", sts[si].style);
                    if (wantPs ? (sts[si].ps === wantPs) : (sts[si].style === "Bold")) selIdx = si;
                }
                ddStyle.selection = selIdx;
            };

            // restore saved font (PS name) -> family + style
            var initFam = 0, savedPs = S.fontName, foundSaved = false;
            for (var fa = 0; fa < CAT.length && !foundSaved; fa++)
                for (var sa = 0; sa < CAT[fa].styles.length; sa++)
                    if (CAT[fa].styles[sa].ps === savedPs) { initFam = fa; foundSaved = true; break; }
            if (!foundSaved)
                for (var fb = 0; fb < CAT.length; fb++)
                    if (CAT[fb].name === "Montserrat") { initFam = fb; break; }

            ddFamily.selection = initFam;
            fillStyles(initFam, foundSaved ? savedPs : null);
            ddFamily.onChange = function () {
                if (ddFamily.selection) fillStyles(ddFamily.selection.index, null);
            };
        } else {
            // app.fonts unavailable - fall back to manual PS-name entry
            gFont.add("statictext", undefined, "Font (PS name):");
            etFont = gFont.add("edittext", undefined, S.fontName); etFont.characters = 18;
        }
        gFont.add("statictext", undefined, "Size:");
        var etSize = gFont.add("edittext", undefined, "" + S.fontSize); etSize.characters = 4;

        function currentFontPS() {
            if (ddFamily && ddFamily.selection && ddStyle && ddStyle.selection)
                return CAT[ddFamily.selection.index].styles[ddStyle.selection.index].ps;
            return etFont ? etFont.text : S.fontName;
        }

        var gTrack = row(pCap);
        gTrack.add("statictext", undefined, "Tracking:");
        var slTrack = gTrack.add("slider", undefined, S.tracking, -50, 200);
        slTrack.preferredSize.width = 100;
        var stTrack = gTrack.add("statictext", undefined, "" + Math.round(S.tracking));
        stTrack.preferredSize.width = 32;
        slTrack.onChanging = function () { stTrack.text = "" + Math.round(slTrack.value); };

        var gColor = row(pCap);
        var cFill = addColorControl(gColor, "Fill:", S.fillHex);
        var cStroke = addColorControl(gColor, "Stroke:", S.strokeHex);
        gColor.add("statictext", undefined, "Width:");
        var etStrokeW = gColor.add("edittext", undefined, "" + S.strokeWidth); etStrokeW.characters = 3;

        var gHl = row(pCap);
        var cbHl = gHl.add("checkbox", undefined, "Highlight spoken word");
        cbHl.value = (S.highlightOn !== false);
        var cHl = addColorControl(gHl, "", S.highlightHex);
        cbHl.onClick = function () { cHl.et.enabled = cbHl.value; cHl.swatch.enabled = cbHl.value; };
        cHl.et.enabled = cbHl.value;
        cHl.swatch.enabled = cbHl.value;

        var gRestyle = row(pCap);
        var btnRestyle = gRestyle.add("button", undefined, "Restyle Selected");
        btnRestyle.onClick = function () {
            collect();
            var comp = app.project ? app.project.activeItem : null;
            if (!(comp && comp instanceof CompItem)) { status("No active composition."); return; }
            var sel = comp.selectedLayers, n = 0;
            app.beginUndoGroup("AutoCaption: Restyle");
            try {
                for (var i = 0; i < sel.length; i++) {
                    if (!(sel[i] instanceof TextLayer)) continue;
                    AC.restyle(sel[i], S);
                    n++;
                }
            } finally { app.endUndoGroup(); }
            status(n ? ("Restyled " + n + " text layer(s).") : "Select text layers first.");
        };

        var gAnim = row(pCap);
        var cbAnim = gAnim.add("checkbox", undefined, "Text animation");
        cbAnim.value = (S.animOn !== false);
        var animNames = [];
        for (var ai = 0; ai < AC.ANIM_PRESETS.length; ai++) animNames.push(AC.ANIM_PRESETS[ai].name);
        var ddAnim = gAnim.add("dropdownlist", undefined, animNames);
        ddAnim.preferredSize.width = 170;
        ddAnim.selection = 0;
        for (var aj = 0; aj < animNames.length; aj++)
            if (animNames[aj] === S.animPreset) ddAnim.selection = aj;
        cbAnim.onClick = function () { ddAnim.enabled = cbAnim.value; };
        ddAnim.enabled = cbAnim.value;
        var btnReanim = gAnim.add("button", undefined, "Apply to Selected");
        btnReanim.onClick = function () {
            collect();
            var comp = app.project ? app.project.activeItem : null;
            if (!(comp && comp instanceof CompItem)) { status("No active composition."); return; }
            var sel = comp.selectedLayers, n = 0;
            app.beginUndoGroup("AutoCaption: Change Animation");
            try {
                for (var i = 0; i < sel.length; i++) {
                    if (!(sel[i] instanceof TextLayer)) continue;
                    AC.clearAnim(sel[i]);
                    AC.addAnimPreset(sel[i], S);
                    n++;
                }
            } finally { app.endUndoGroup(); }
            status(n ? ((cbAnim.value ? "Set " + S.animPreset : "Removed animation") + " on " + n + " text layer(s).")
                     : "Select text layers first.");
        };

        var gGen = row(pCap);
        var btnGenerate = gGen.add("button", undefined, "GENERATE CAPTIONS");
        btnGenerate.preferredSize.width = 250;
        btnGenerate.preferredSize.height = 32;

        // ===== status =====
        var stStatus = win.add("statictext", undefined, "Ready.", { truncate: "end" });
        stStatus.alignment = ["fill", "bottom"];

        function status(msg) { stStatus.text = msg; win.update && win.update(); }

        // ---------------- collect + persist ----------------

        function collect() {
            S.language = LANGS[ddLang.selection.index].code;
            S.snapToFrame = cbSnap.value;
            S.stripPunct = cbPunct.value;
            S.placement = ddPlace.selection.text;
            S.customY = parseFloat(etY.text) || 85;
            S.wordsPerScreen = Math.round(slWords.value);
            S.smartChunk = cbSmart.value;
            S.fontName = currentFontPS();
            S.fontSize = parseFloat(etSize.text) || 80;
            S.tracking = Math.round(slTrack.value);
            S.fillHex = cFill.et.text.replace("#", "");
            S.strokeHex = cStroke.et.text.replace("#", "");
            S.strokeWidth = parseFloat(etStrokeW.text) || 0;
            S.highlightOn = cbHl.value;
            S.highlightHex = cHl.et.text.replace("#", "");
            S.animOn = cbAnim.value;
            S.animPreset = ddAnim.selection ? ddAnim.selection.text : DEFAULTS.animPreset;
            saveSettings(S);
            return S;
        }

        // ---------------- handlers ----------------

        btnTranscribe.onClick = function () {
            collect();
            var sel = getSelectedLayer();
            if (sel.err) { status(sel.err); return; }
            var key = keyFor(S.provider);
            if (!key) {
                gApi.visible = true; gKeyDone.visible = false;
                if (win.layout) try { win.layout.layout(true); } catch (e) {}
                status("No API key - paste your " + S.provider + " key and hit Save.");
                return;
            }
            status("Transcribing '" + sel.layer.name + "' via " + S.provider + "... AE will pause briefly.");
            var r = AC.transcribeAndMark(sel.layer, {
                provider: S.provider, apiKey: key, language: S.language,
                snapToFrame: S.snapToFrame, stripPunct: S.stripPunct
            });
            if (r.err) { status("FAILED: " + r.err); return; }
            status("Done: " + r.added + " word markers on '" + sel.layer.name + "'. Check + fix any, then Generate.");
        };

        btnImport.onClick = function () {
            collect();
            var sel = getSelectedLayer();
            if (sel.err) { status(sel.err); return; }
            var f = File.openDialog("Pick transcript (WhisperX/verbose JSON or SRT)");
            if (!f) return;
            var words = null;
            if (/\.srt$/i.test(f.name)) {
                words = AC.parseSRT(f.fsName);
            } else {
                var t = AC.flatten(f.fsName);
                if (t.err) { status("FAILED: " + t.err); return; }
                words = AC.readWords(t.tsv);
            }
            if (!words || words.length === 0) { status("No words found in " + f.displayName + "."); return; }
            var r = AC.addWordMarkers(sel.layer, words, { snapToFrame: S.snapToFrame, stripPunct: S.stripPunct });
            if (r.err) { status("FAILED: " + r.err); return; }
            status("Imported " + r.added + " markers from " + f.displayName + ".");
        };

        btnClear.onClick = function () {
            var sel = getSelectedLayer();
            if (sel.err) { status(sel.err); return; }
            var n = AC.clearMarkers(sel.layer);
            status(n ? ("Removed " + n + " markers from '" + sel.layer.name + "'.")
                     : ("No markers on '" + sel.layer.name + "'."));
        };

        btnGenerate.onClick = function () {
            collect();
            var sel = getSelectedLayer();
            if (sel.err) { status(sel.err); return; }
            status("Generating captions...");
            var r = AC.generateCaptions(sel.layer, S);
            if (r.err) { status("FAILED: " + r.err); return; }
            status("Generated " + r.layers + " caption layers from " + r.chunks + " chunks"
                + (r.cleared ? " (replaced " + r.cleared + " old layers)" : "") + ".");
        };

        win.onResizing = win.onResize = function () { this.layout.resize(); };
        if (win instanceof Window) { win.center(); win.show(); }
        else { win.layout.layout(true); }
        syncKeyUI();

        return win;
    }

    if (!$.global.AC_CORE_ONLY) buildUI(thisObj);
    $.global.AC_CORE_ONLY = false;

})(this);
