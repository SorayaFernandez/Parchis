export default function BoardEffects() {
  return (
    <div className="absolute inset-0 pointer-events-none">
      <div className="w-full h-full bg-gradient-radial from-transparent to-black opacity-40" />

      {/* glow pulse center */}
      <div className="absolute left-1/2 top-1/2 w-40 h-40 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cyan-400 blur-3xl opacity-10 animate-pulse" />
    </div>
  );
}