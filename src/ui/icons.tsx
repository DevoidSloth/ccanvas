// Minimal stroke-based icon set. All share a 24x24 viewBox and inherit
// currentColor so they tint with their container.

type P = { className?: string; size?: number }

// Icons fill their container by default (width/height 100%); any explicit
// `.x svg { width }` rule in the stylesheet overrides the presentation attr,
// and callers can force a pixel size with the `size` prop.
const S = (props: { children: React.ReactNode } & P) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    width={props.size ?? '100%'}
    height={props.size ?? '100%'}
    style={{ display: 'block' }}
    className={props.className}
  >
    {props.children}
  </svg>
)

export const IconSelect = (p: P) => (
  <S {...p}>
    <path d="M5 3l6.5 15.5 2.2-6.3 6.3-2.2L5 3z" />
  </S>
)

export const IconHand = (p: P) => (
  <S {...p}>
    <path d="M8 13V5.5a1.5 1.5 0 013 0V11" />
    <path d="M11 11V4.5a1.5 1.5 0 013 0V11" />
    <path d="M14 11V6a1.5 1.5 0 013 0v7" />
    <path d="M17 9.5a1.5 1.5 0 013 0V14c0 3.5-2.2 6.5-6 6.5-2.5 0-3.9-1-5.2-2.6L5 13.2c-.7-1 .6-2.3 1.6-1.6L8 13" />
  </S>
)

export const IconPen = (p: P) => (
  <S {...p}>
    <path d="M3 21c2-1 3-2 4.5-3.5L18 7a2 2 0 00-3-3L4.5 14.5C3 16 2 17 1 19" transform="translate(2 0)" />
    <path d="M14 6l4 4" />
  </S>
)

export const IconArrow = (p: P) => (
  <S {...p}>
    <path d="M4 20L20 4" />
    <path d="M20 11V4h-7" />
  </S>
)

export const IconText = (p: P) => (
  <S {...p}>
    <path d="M5 6V4.5h14V6" />
    <path d="M12 4.5V20" />
    <path d="M9 20h6" />
  </S>
)

export const IconRect = (p: P) => (
  <S {...p}>
    <rect x="4" y="6" width="16" height="12" rx="1.5" />
  </S>
)

export const IconEllipse = (p: P) => (
  <S {...p}>
    <ellipse cx="12" cy="12" rx="8.5" ry="6.5" />
  </S>
)

export const IconEraser = (p: P) => (
  <S {...p}>
    <path d="M4 16l6-6 8 8H8l-4-4z" />
    <path d="M10 10l5-5 5 5-5 5" />
  </S>
)

export const IconAgent = (p: P) => (
  <S {...p}>
    <path d="M12 3.2l1.9 6.9 6.9 1.9-6.9 1.9L12 20.8l-1.9-6.9L3.2 12l6.9-1.9z" />
  </S>
)

export const IconTerminal = (p: P) => (
  <S {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 9l3 3-3 3" />
    <path d="M12.5 15h4" />
  </S>
)

export const IconWeb = (p: P) => (
  <S {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17" />
    <path d="M12 3.5c2.5 2.4 2.5 14.6 0 17M12 3.5c-2.5 2.4-2.5 14.6 0 17" />
  </S>
)

export const IconNote = (p: P) => (
  <S {...p}>
    <path d="M5 3.5h9l5 5V20a1 1 0 01-1 1H5a1 1 0 01-1-1V4.5a1 1 0 011-1z" />
    <path d="M14 3.5V9h5" />
    <path d="M8 13h7M8 16.5h5" />
  </S>
)

export const IconPlus = (p: P) => (
  <S {...p}>
    <path d="M12 5v14M5 12h14" />
  </S>
)

export const IconMinus = (p: P) => (
  <S {...p}>
    <path d="M5 12h14" />
  </S>
)

export const IconClose = (p: P) => (
  <S {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </S>
)

export const IconFit = (p: P) => (
  <S {...p}>
    <path d="M4 9V5a1 1 0 011-1h4" />
    <path d="M20 9V5a1 1 0 00-1-1h-4" />
    <path d="M4 15v4a1 1 0 001 1h4" />
    <path d="M20 15v4a1 1 0 01-1 1h-4" />
  </S>
)

export const IconFolder = (p: P) => (
  <S {...p}>
    <path d="M3 7a1 1 0 011-1h5l2 2h9a1 1 0 011 1v9a1 1 0 01-1 1H4a1 1 0 01-1-1V7z" />
  </S>
)

// Arrow leaving a box — "open / reveal externally (OS file manager)".
export const IconExternal = (p: P) => (
  <S {...p}>
    <path d="M14 4h6v6" />
    <path d="M20 4l-8 8" />
    <path d="M18 13v6a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h6" />
  </S>
)

export const IconSave = (p: P) => (
  <S {...p}>
    <path d="M5 3h11l3 3v14a1 1 0 01-1 1H5a1 1 0 01-1-1V4a1 1 0 011-1z" />
    <path d="M8 3v5h7V3" />
    <rect x="8" y="13" width="8" height="6" rx=".5" />
  </S>
)

export const IconReload = (p: P) => (
  <S {...p}>
    <path d="M20 8a8 8 0 10.5 6" />
    <path d="M20 4v4h-4" />
  </S>
)

export const IconBack = (p: P) => (
  <S {...p}>
    <path d="M15 5l-7 7 7 7" />
  </S>
)

export const IconFiles = (p: P) => (
  <S {...p}>
    <path d="M4 5.5h5l1.5 2H20a.5.5 0 01.5.5v10a1 1 0 01-1 1H4.5a.5.5 0 01-.5-.5V5.5z" />
    <path d="M8 12h8M8 15h5" />
  </S>
)

export const IconDiff = (p: P) => (
  <S {...p}>
    <path d="M7 4v9a3 3 0 003 3h4" />
    <circle cx="7" cy="4" r="1.8" />
    <circle cx="17" cy="16" r="1.8" />
    <path d="M17 8v6M14 11h6" />
  </S>
)

export const IconEditor = (p: P) => (
  <S {...p}>
    <path d="M9 8l-4 4 4 4" />
    <path d="M15 8l4 4-4 4" />
  </S>
)

export const IconDoc = (p: P) => (
  <S {...p}>
    <path d="M6 3.5h7l5 5V20a1 1 0 01-1 1H6a1 1 0 01-1-1V4.5a1 1 0 011-1z" />
    <path d="M13 3.5V9h5" />
    <path d="M8.5 12.5h7M8.5 15.5h7M8.5 18h4" />
  </S>
)

// A plain file/page with a folded corner (no text lines) — "open a local file".
export const IconFile = (p: P) => (
  <S {...p}>
    <path d="M6 3.5h7l5 5V20a1 1 0 01-1 1H6a1 1 0 01-1-1V4.5a1 1 0 011-1z" />
    <path d="M13 3.5V9h5" />
  </S>
)

export const IconLog = (p: P) => (
  <S {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <path d="M7 9h2M7 12h2M7 15h2M12 9h5M12 12h5M12 15h3" />
  </S>
)

export const IconImage = (p: P) => (
  <S {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <circle cx="9" cy="10" r="1.8" />
    <path d="M5 18l5-5 4 4 2-2 3 3" />
  </S>
)

export const IconFrame = (p: P) => (
  <S {...p}>
    <path d="M7 3v18M17 3v18M3 7h18M3 17h18" />
  </S>
)

export const IconLock = (p: P) => (
  <S {...p}>
    <rect x="5" y="10.5" width="14" height="9" rx="1.5" />
    <path d="M8 10.5V8a4 4 0 018 0v2.5" />
  </S>
)

export const IconUnlock = (p: P) => (
  <S {...p}>
    <rect x="5" y="10.5" width="14" height="9" rx="1.5" />
    <path d="M8 10.5V8a4 4 0 017.6-1.8" />
  </S>
)

export const IconCopy = (p: P) => (
  <S {...p}>
    <rect x="8" y="8" width="12" height="12" rx="1.5" />
    <path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3" />
  </S>
)

export const IconGroup = (p: P) => (
  <S {...p}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1" />
  </S>
)

export const IconSearch = (p: P) => (
  <S {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4 4" />
  </S>
)

export const IconBroadcast = (p: P) => (
  <S {...p}>
    <circle cx="12" cy="12" r="2.2" />
    <path d="M7.5 7.5a6 6 0 000 9M16.5 7.5a6 6 0 010 9" />
    <path d="M5 5a9 9 0 000 14M19 5a9 9 0 010 14" />
  </S>
)

export const IconLayers = (p: P) => (
  <S {...p}>
    <path d="M12 3.5l8 4.5-8 4.5-8-4.5 8-4.5z" />
    <path d="M4 12l8 4.5 8-4.5" />
  </S>
)

export const IconSendBack = (p: P) => (
  <S {...p}>
    <rect x="4" y="4" width="11" height="11" rx="1.5" />
    <path d="M9 20h10a1 1 0 001-1V9" />
  </S>
)

export const IconAlignLeft = (p: P) => (
  <S {...p}>
    <path d="M4 4v16" />
    <rect x="7" y="7" width="11" height="3.5" rx="1" />
    <rect x="7" y="13.5" width="7" height="3.5" rx="1" />
  </S>
)

export const IconTidy = (p: P) => (
  <S {...p}>
    <rect x="4" y="4" width="7" height="7" rx="1" />
    <rect x="13" y="4" width="7" height="7" rx="1" />
    <rect x="4" y="13" width="7" height="7" rx="1" />
    <rect x="13" y="13" width="7" height="7" rx="1" />
  </S>
)

export const IconPr = (p: P) => (
  <S {...p}>
    <circle cx="6" cy="6" r="2.2" />
    <circle cx="6" cy="18" r="2.2" />
    <circle cx="18" cy="18" r="2.2" />
    <path d="M6 8.2v7.6" />
    <path d="M18 15.8V11a3 3 0 00-3-3h-3m0 0l2.5-2.5M12 8l2.5 2.5" />
  </S>
)

export const IconRun = (p: P) => (
  <S {...p}>
    <path d="M7 5l11 7-11 7V5z" />
  </S>
)

export const IconIssue = (p: P) => (
  <S {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
  </S>
)

export const IconChecks = (p: P) => (
  <S {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M8.5 12.2l2.4 2.4 4.6-5" />
  </S>
)

export const IconSettings = (p: P) => (
  <S {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4L5.3 5.3" />
  </S>
)

export const IconTemplate = (p: P) => (
  <S {...p}>
    <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
    <path d="M3.5 9h17M9 9v11.5" />
  </S>
)

export const IconMark = (p: P) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    width={p.size ?? '100%'}
    height={p.size ?? '100%'}
    style={{ display: 'block' }}
    className={p.className}
  >
    <circle
      cx="12"
      cy="12"
      r="8"
      stroke="currentColor"
      strokeWidth="2"
      fill="none"
    />
    <circle cx="12" cy="12" r="2.2" fill="currentColor" />
    <path
      d="M12 4v3M12 17v3M4 12h3M17 12h3"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    />
  </svg>
)
