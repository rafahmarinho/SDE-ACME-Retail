export function Swatch({ hue, name }: { hue: number; name: string }) {
  return (
    <div
      className="grid h-40 place-items-end rounded-xl p-3 text-sm font-semibold text-white"
      style={{ background: `linear-gradient(145deg, hsl(${hue} 32% 42%), hsl(${(hue + 24) % 360} 28% 24%))` }}
      aria-hidden
    >
      <span className="rounded-full bg-black/30 px-2 py-1">{name}</span>
    </div>
  );
}
