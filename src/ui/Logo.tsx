/**
 * The L3 mark: white "L3" on a navy tile.
 *
 * Inline SVG rather than an image file so it costs no request and stays crisp
 * at any size. The navy is fixed rather than themed — a mark that changes
 * colour with the palette is decoration, not identity — and it is the same
 * navy as the installed home-screen icon, which `scripts/make-icons.py`
 * renders from the same two values. Change one, re-run that.
 */
export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg
      className="logo"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="Lingu3"
    >
      <rect width="64" height="64" rx="14" fill="var(--logo-tile)" />
      <text
        x="32"
        y="33"
        textAnchor="middle"
        dominantBaseline="central"
        fill="var(--logo-ink)"
        fontFamily="Georgia, 'Times New Roman', serif"
        fontSize="38"
        fontWeight="700"
        letterSpacing="-1"
      >
        L3
      </text>
    </svg>
  )
}
