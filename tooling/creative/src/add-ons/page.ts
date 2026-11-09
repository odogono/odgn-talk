// The page's Add-on loader (#1901): it registers each kind's view too, giving
// it Folio's Preact and Info controls.
import { Fragment, h } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { controls } from '../elements/controls';
import { registerAddOnView } from '../elements/views';
import type { AddOnViewApi } from './api';
import { AddOnLoader, type AddOnLoaderOptions } from './loader';
import { TrustStore } from './trust';

export const VIEW_API: AddOnViewApi = {
  controls,
  Fragment: Fragment as AddOnViewApi['Fragment'],
  h,
  hooks: { useEffect, useLayoutEffect, useRef, useState },
};

/** The Project Add-ons this reader trusts (ADR 0162). */
export const pageTrust = new TrustStore();

/** A page loader, which also registers each kind's view. */
export const pageAddOnLoader = (
  options: Omit<AddOnLoaderOptions, 'onView'> = {},
): AddOnLoader =>
  new AddOnLoader({
    trusted: hash => pageTrust.has(hash),
    ...options,
    onView: (kind, module) => {
      if (module.view) {
        registerAddOnView(kind, module.view(VIEW_API));
      }
    },
  });

/** The page's loader; a browser suite may swap in its own catalogue. */
export let pageAddOns = pageAddOnLoader();

export const setPageAddOns = (loader: AddOnLoader): void => {
  pageAddOns = loader;
};
