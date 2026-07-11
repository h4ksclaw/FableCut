/* FableCut landing - progressive enhancement only. The page is fully
   readable with JS disabled; this adds nav state, reveals, copy buttons
   and a live latest-release badge. */
(function () {
  "use strict";

  /* Nav: solid border once scrolled, mobile menu toggle */
  var nav = document.getElementById("nav");
  var toggle = document.getElementById("navToggle");
  var links = document.querySelector(".nav-links");

  /* Toggle the nav border via a 1px sentinel + IntersectionObserver
     instead of a scroll handler. */
  if ("IntersectionObserver" in window) {
    var sentinel = document.createElement("div");
    sentinel.style.cssText = "position:absolute;top:0;left:0;height:1px;width:1px;pointer-events:none;";
    document.body.prepend(sentinel);
    new IntersectionObserver(function (entries) {
      nav.classList.toggle("scrolled", !entries[0].isIntersecting);
    }, { threshold: 0 }).observe(sentinel);
  }

  if (toggle && links) {
    toggle.addEventListener("click", function () {
      var open = links.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    links.addEventListener("click", function (e) {
      if (e.target.tagName === "A") {
        links.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  /* Scroll reveal via IntersectionObserver (no scroll handler) */
  var reveals = document.querySelectorAll(".reveal");
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || !("IntersectionObserver" in window)) {
    reveals.forEach(function (el) { el.classList.add("in"); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
      });
    }, { threshold: 0.14, rootMargin: "0px 0px -8% 0px" });
    reveals.forEach(function (el) { io.observe(el); });
  }

  /* Copy buttons */
  document.querySelectorAll(".copy").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var el = document.getElementById(btn.getAttribute("data-target"));
      if (!el) return;
      var done = function () {
        var prev = btn.textContent;
        btn.textContent = "Copied";
        btn.classList.add("done");
        setTimeout(function () { btn.textContent = prev; btn.classList.remove("done"); }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(el.innerText).then(done).catch(function () {});
      }
    });
  });

  /* Live latest-release badge from the public GitHub API */
  var tagEl = document.getElementById("relTag");
  var metaEl = document.getElementById("relMeta");
  var linkEl = document.getElementById("relLink");
  if (tagEl && metaEl) {
    fetch("https://api.github.com/repos/ronak-create/FableCut/releases/latest", {
      headers: { Accept: "application/vnd.github+json" }
    })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (rel) {
        var tag = rel.tag_name || "";
        var name = rel.name && rel.name !== tag ? rel.name : "";
        tagEl.textContent = tag ? "Latest release " + tag : "Latest release";
        var when = rel.published_at
          ? new Date(rel.published_at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })
          : "";
        metaEl.textContent = [name, when ? "Published " + when : ""].filter(Boolean).join(" . ")
          || "See the changelog for what shipped.";
        if (linkEl && rel.html_url) linkEl.href = rel.html_url;
      })
      .catch(function () {
        tagEl.textContent = "Latest release";
        metaEl.textContent = "See the releases page for the newest version.";
      });
  }
})();
