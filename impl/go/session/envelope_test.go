package session

import "testing"

func TestEnvelopeFramingRejectsMalformedMetadata(t *testing.T) {
	for _, raw := range []string{
		`{"type":"setup","type":"setup","objects":{}}`,
		`{"type":"setup","objects":{},"extra":0}`,
		`{"type":"object","object":{"kind":"k","id":"i","extra":0}}`,
		`{"type":"property-end","crossing":0,"reply":{"ok":true}}`,
		`{"type":"property-end","crossing":"1","reply":{"ok":true}}`,
		`{"type":"property-end","crossing":9007199254740992,"reply":{"ok":true}}`,
		`{"type":"property-end","crossing":1,"reply":{"hostError":false}}`,
		`{"type":"property-end","crossing":1,"reply":{"fail":{"code":"x","message":"x","data":{},"extra":1}}}`,
		`{"type":"function","handle":"f0","exposure":1,"path":[]}`,
		`{"type":"function","handle":"f1","exposure":1,"path":[-1]}`,
		`{"type":"input","request":{"kind":"pump"},"reply":{"ok":{}}}`,
		`{"type":"input","request":{"kind":"deliver","to":{"script":"session"},"message":{"name":"x","args":false}},"reply":{"ok":{}}}`,
		`{"type":"input","request":{"kind":"decide","broadcast":false,"message":{"name":"x"}},"reply":{"ok":{}}}`,
		`{"type":"input","request":{"kind":"call","fn":null,"args":[],"limits":{"extra":1}},"reply":{"ok":{}}}`,
		`{"type":"input","request":{"kind":"answer","call":"c","value":null,"fuel":-1},"reply":{"ok":{}}}`,
		`{"type":"input","request":{"kind":"settle","call":"c","settlement":{"adopt":false}},"reply":{"ok":{}}}`,
		`{"type":"resolve","objects":[{"object":{"kind":"k","id":"i"},"resolved":1}]}`,
	} {
		if _, e := ParseEnvelope(raw); e == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
	if _, e := ParseEnvelope(`{"type":"property-end","crossing":"9007199254740992","reply":{"ok":true}}`); e != nil {
		t.Fatal(e)
	}
}
