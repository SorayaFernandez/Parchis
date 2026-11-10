type PieceProps = {
  x: number;
  y: number;
  color: string;
  onClick?: () => void;
};

export default function Piece({
  x,
  y,
  color,
  onClick,
}: PieceProps) {
  return (
    <g
      onClick={onClick}
      style={{
        transform: `translate(${x}px, ${y}px)`,
        cursor: "pointer",
      }}
    >
      <circle
        r={28}
        fill={color}
        opacity={0.18}
        style={{
          filter: `blur(10px)`,
        }}
      />

      <circle
        r={18}
        fill={color}
        style={{
          filter: `drop-shadow(0 0 18px ${color})`,
        }}
      />

      <circle
        cy={-5}
        r={7}
        fill="rgba(255,255,255,.65)"
      />
    </g>
  );
}