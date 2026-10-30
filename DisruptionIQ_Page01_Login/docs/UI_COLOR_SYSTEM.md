# DisruptionIQ UI Color System

The application uses the Ice & Butter palette across the Hub application, login experience, Recovery Management workbench, and Customer Portal.

| Token | Hex | Usage |
|---|---|---|
| Deep Navy | `#2F4860` | Primary text, navigation, brand surfaces and primary actions |
| Clean White | `#FFFFFF` | Main cards, forms and content surfaces |
| Soft Cobalt | `#7DA7D9` | Interactive accents, focus states, selected states and links |
| Butter Yellow | `#FFF7CC` | Warm highlight, selected accent and non-critical emphasis |
| Ice Blue | `#DCEEFF` | Application canvas, secondary surfaces and customer portal background |

Semantic status colours remain separate from the brand palette so warning, error and success states remain distinguishable. The optional dark theme uses navy-toned surfaces with ice-blue text and cobalt accents while retaining butter-yellow highlights.

Implementation:
- `public/css/styles.css`: shared design tokens, login, Hub and Recovery Management styling.
- `public/css/customer.css`: Customer Portal palette mapping.
- `public/login.html` and `public/customer.html`: browser theme colour metadata.
