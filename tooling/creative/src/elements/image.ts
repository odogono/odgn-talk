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
});
