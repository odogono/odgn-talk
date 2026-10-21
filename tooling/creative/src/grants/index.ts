// Every Grant a Folio Script holds, in Manifest order (#1453).
import { canvasGrant, type CanvasState } from './canvas';
import { elementsGrant, type ElementsState } from './elements';
import { folioGrant, type FolioState } from './folio';
import { manifestGrant, libraryDeclarations } from './grant';
import { pagesGrant, type PagesState } from './pages';
import { soundGrant, type SoundState } from './sound';
import { userGrant, type UserState } from './user';

export const FOLIO_GRANTS = [
  pagesGrant,
  elementsGrant,
  soundGrant,
  userGrant,
  folioGrant,
  canvasGrant,
] as const;

/** The session state every Grant reads, as one Play Session supplies it. */
export type GrantStates = {
  canvas: CanvasState;
  elements: ElementsState;
  folio: FolioState;
  pages: PagesState;
  sound: SoundState;
  user: UserState;
};

/** One Script's Grants over a session's state, by name. */
export const grantsFor = (states: GrantStates) => ({
  pages: pagesGrant.grant(states.pages),
  elements: elementsGrant.grant(states.elements),
  sound: soundGrant.grant(states.sound),
  user: userGrant.grant(states.user),
  folio: folioGrant.grant(states.folio),
  canvas: canvasGrant.grant(states.canvas),
});

export const manifestGrants = () => FOLIO_GRANTS.map(manifestGrant);

/** The Grant declarations Library compilation checks calls against. */
export const grantDeclarations = () =>
  Object.fromEntries(
    FOLIO_GRANTS.map(grant => [grant.name, libraryDeclarations(grant)]),
  );
