# Original demo images

Five images were generated with the built-in image-generation tool for this
fictional property. They are illustrations, not photos of the Airbnb listing or
proof of an actual Boston rental. No CLI/API fallback or external image service
is used at runtime. Source screenshots guided composition only.

Saved website assets: `public/assets/living.png`, `kitchen.png`, `bedroom.png`,
`kitchen-front.png`, and `kitchen-side.png`. Both variants share these files.

Prompt briefs used for the generated interiors:

- Living: realistic wide interior photograph, warm wood floors, cream sectional
  on the right, dark cherry shelving/TV on the left, traditional rug and wood
  coffee table, oak kitchen beyond, daylight and a ceiling fan.
- Kitchen: realistic traditional honey-oak kitchen opening onto a wooden dining
  table, stainless appliances, cream walls, warm wood flooring and daylight.
- Bedroom: quiet traditional bedroom, cream linen double bed, white walls,
  tall daylight windows, neutral curtains and dark wooden dresser/mirror.
- Kitchen front: frontal oak kitchen, stainless refrigerator, central window
  over the sink, simple granite counter and warm, natural daylight.
- Kitchen side: side view of the same general traditional oak kitchen, window
  over the sink, counter in the foreground and bright rear doorway.

All briefs requested original fictional interiors with no people, branding,
watermarks or text. The five generated rooms are illustrative and are not a
claim of geometrically consistent photography of a real property.

Older `.svg` prototypes are not required or included in this demo release.
They may remain in the original working copy to preserve prior work, but are
not referenced by the pages, served by the preview, or deployed.

`hosting-images/*.jpg` are deployment-only JPEG encoding copies (quality 85)
of those same five original PNGs. They were converted locally with the installed
macOS image utility solely to fit the Worker bundle; no images were regenerated,
substituted or downloaded. Both variants use the same packaged bytes. The
original PNGs are preserved and no conversion tool is needed for a fresh clone
to run or rebuild the existing deployment.
