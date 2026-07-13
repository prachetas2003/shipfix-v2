"use client";

import { useEffect, useRef } from "react";

type Blob = {
  x: number;
  y: number;
  r: number;
  vx: number;
  vy: number;
  color: string;
};

/**
 * Canvas aurora backdrop — guaranteed visible motion (CSS alone was too easy to miss).
 * Freezes when the user prefers reduced motion.
 */
export function Atmosphere(): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let w = 0;
    let h = 0;
    let dpr = 1;

    const blobs: Blob[] = [
      { x: 0.2, y: 0.15, r: 0.42, vx: 0.0011, vy: 0.0007, color: "74, 159, 212" },
      { x: 0.82, y: 0.2, r: 0.36, vx: -0.0009, vy: 0.001, color: "110, 184, 224" },
      { x: 0.45, y: 0.85, r: 0.4, vx: 0.00075, vy: -0.00085, color: "62, 207, 142" },
    ];

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const drawGrid = () => {
      const step = 32;
      ctx.fillStyle = "rgba(255,255,255,0.07)";
      const ox = (performance.now() / 35) % step;
      for (let x = -step + ox; x < w + step; x += step) {
        for (let y = -step + ox; y < h + step; y += step) {
          const dx = x / w - 0.5;
          const dy = y / h - 0.35;
          const falloff = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) * 1.6);
          if (falloff < 0.05) continue;
          ctx.globalAlpha = 0.55 * falloff;
          ctx.beginPath();
          ctx.arc(x, y, 1.1, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    };

    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#090a0d";
      ctx.fillRect(0, 0, w, h);

      for (const b of blobs) {
        if (!reduce) {
          b.x += b.vx;
          b.y += b.vy;
          if (b.x < 0.05 || b.x > 0.95) b.vx *= -1;
          if (b.y < 0.05 || b.y > 0.95) b.vy *= -1;
        }
        const cx = b.x * w;
        const cy = b.y * h;
        const radius = b.r * Math.max(w, h);
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
        g.addColorStop(0, `rgba(${b.color}, 0.55)`);
        g.addColorStop(0.4, `rgba(${b.color}, 0.22)`);
        g.addColorStop(1, `rgba(${b.color}, 0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fill();
      }

      // Soft diagonal beam
      if (!reduce) {
        const t = (Math.sin(performance.now() / 2800) + 1) / 2;
        const bx = w * (0.25 + t * 0.5);
        const beam = ctx.createLinearGradient(bx - w * 0.15, 0, bx + w * 0.15, h);
        beam.addColorStop(0, "rgba(159,208,239,0)");
        beam.addColorStop(0.5, "rgba(91,159,212,0.1)");
        beam.addColorStop(1, "rgba(159,208,239,0)");
        ctx.fillStyle = beam;
        ctx.fillRect(0, 0, w, h);
      }

      drawGrid();

      if (!reduce) raf = requestAnimationFrame(draw);
    };

    resize();
    draw();
    window.addEventListener("resize", resize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <div className="sf-atmosphere" aria-hidden="true">
      <canvas ref={canvasRef} className="sf-atmosphere__canvas" />
    </div>
  );
}
