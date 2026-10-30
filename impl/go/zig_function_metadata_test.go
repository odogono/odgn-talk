package northtalk

import (
	"testing"

	"northtalk.org/go/internal/docs"
)

func TestZigBackendFunctionMetadataDecoder(t *testing.T) {
	b := &zigGroup{group: &Group{}}
	for _, test := range []struct {
		payload         string
		name            string
		required, total int
	}{
		{`["s","<function s:f>","opaque","f",1,2]`, "f", 1, 2},
		{`["s","<function s:1:1>","opaque",null,2,2]`, "", 2, 2},
		{`["s","<function s:1:1>","opaque",null,0,0]`, "", 0, 0},
		{`["s","<function s:f>","opaque"]`, "", 0, 0},
	} {
		v, err := b.decodeValue([]byte(`{"$function":` + test.payload + `}`))
		if err != nil {
			t.Fatal(err)
		}
		name, required, total, ok := docs.FunctionHead(v)
		if !ok || name != test.name || required != test.required || total != test.total {
			t.Fatalf("%s: got %q %d..%d", test.payload, name, required, total)
		}
	}
	for _, payload := range []string{
		`[]`, `["s","display","token",null,1]`,
		`["s","display","token",true,1,1]`,
		`["s","display","token",null,"1",1]`,
		`["s","display","token",null,-1,1]`,
		`["s","display","token",null,2,1]`,
		`["s","display","token",null,0,{"$dec":"1.5"}]`,
		`["s","display","token",null,0,{"$dec":"9223372036854775808"}]`,
		`["s","display","token",null,0,0,"source"]`,
		`["s","display","token",null,0,0,{"$bytes":"AA=="}]`,
	} {
		if _, err := b.decodeValue([]byte(`{"$function":` + payload + `}`)); err == nil {
			t.Errorf("accepted malformed Function metadata %s", payload)
		}
	}
}
