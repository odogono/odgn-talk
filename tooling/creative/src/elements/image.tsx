/** @jsxImportSource preact */
// The pragma lets code run outside Folio's tsconfig, such as `bun test`
// from the repo root, compile this file: model.ts reaches every kind.
// The image Element: shows an asset from the Project's asset table.
import { commonProperties, defineElementKind, property } from './definition';

export const imageKind = defineElementKind({
  kind: 'image',
  label: 'Image',
  icon: '▨',
  creatable: true,
  asset: element => element.image,
  properties: { ...commonProperties, image: property('image', 'text') },
  create: base => ({ ...base, kind: 'image', image: '' }),
  check: (c, e, path, { base }) => ({
    ...base(),
    kind: 'image',
    image: c.str(e.image, `${path}.image`) ?? '',
  }),
  Contents: ({ element, imageUrl, reader }) => {
    if (imageUrl) {
      return <img alt={element.image} draggable={false} src={imageUrl} />;
    }
    return (
      <>
        <span>
          {element.image ? `Missing image: ${element.image}` : 'Image'}
        </span>
        {!reader && (
          <button data-replace-image={element.name} type="button">
            Replace…
          </button>
        )}
      </>
    );
  },
  info: (element, { disabled }) => (
    <button data-replace-image={element.name} disabled={disabled} type="button">
      Replace image…
    </button>
  ),
});
