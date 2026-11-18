/** Dependency-free sparkline / area chart with an optional spike marker. */
export function Sparkline({
  data,
  width = 280,
  height = 54,
  color = "#8a8a92",
  markerIndex,
  fill = true,
}: {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  markerIndex?: number;
  fill?: boolean;
}) {
  if (!data.length) data = [0];
  const max = Math.max(...data, 1);
  const stepX = data.length > 1 ? width / (data.length - 1) : width;
  const y = (v: number) => height - 3 - (v / max) * (height - 8);

  const points = data.map((v, i) => `${(i * stepX).toFixed(1)},${y(v).toFixed(1)}`);
  const line = `M${points.join(" L")}`;
  const area = `${line} L${width},${height} L0,${height} Z`;

  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ display: "block", overflow: "visible" }}
      aria-hidden
    >
      {fill ? <path d={area} fill={color} fillOpacity="0.09" /> : null}
      <path d={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      {markerIndex !== undefined && data[markerIndex] !== undefined ? (
        <circle
          cx={markerIndex * stepX}
          cy={y(data[markerIndex])}
          r="2.6"
          fill="#e05252"
          stroke="#171719"
          strokeWidth="1.5"
        />
      ) : null}
    </svg>
  );
}
