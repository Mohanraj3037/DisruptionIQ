# DisruptionIQ visual system: LEC editorial adaptation

This theme is adapted from the user-provided `lec.devtools` HAR capture of
`https://lec.it/uk/story/`. The capture's actual CSS and font resources were
inspected; the implementation does not copy the LEC website's page or business
content into the logistics application.

## Palette extracted from the reference

| Token | Hex | Application |
|---|---|---|
| Espresso | `#563121` | Primary text, dark navigation, login hero |
| Golden yellow | `#FCC43F` | Primary actions, active navigation, emphasis |
| Warm white | `#FFFFFF` | Main cards and surfaces |
| Vanilla | `#FFFAF5` | Main page background |
| Cream | `#FFF5EB` | Secondary panels and table headers |
| Peach | `#FFEDDC` | Soft supporting surface |
| Caramel | `#944C0A` | Link and secondary accent |
| Olive | `#5D5510` | Supporting accent |
| Red | `#ED4242` | Error / destructive states |
| Green | `#57C575` | Success states |

## Typography

The four WOFF font files included in `public/assets/fonts/` are the font
resources captured in the supplied HAR:

- ABC ROM Book: body and normal text
- ABC ROM Compressed Bold: large display headings and section titles
- ABC ROM Wide Bold: numeric and compact emphasis
- ABC ROM Wide Heavy: high-emphasis numeric/display use

Fonts are served locally from the project, so the UI does not depend on the
reference website being online.

## Component language adapted

- Dark espresso navigation and hero surfaces
- Golden pill-shaped primary actions and selected navigation states
- Warm white cards on a vanilla canvas
- Cream table headers and secondary panels
- Condensed uppercase display headings with compact editorial labels
- Soft warm borders, restrained shadows and rounded data surfaces
- Responsive heading scale and clear hover/focus feedback

## Scope and safeguards

The existing DisruptionIQ layout, five primary navigation destinations,
HUB_INCHARGE and CUSTOMER roles, APIs, database, business logic and workflow
behaviour are preserved. LEC-specific food photography, logos, page copy,
analytics, cookie scripts and unrelated site components are not copied into
DisruptionIQ. The dark theme is mapped to espresso and warm cream equivalents.
