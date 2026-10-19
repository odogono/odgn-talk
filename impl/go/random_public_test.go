package northtalk_test

import (
	"testing"
	"time"

	talk "github.com/odogono/odgn-talk/impl/go"
)

// Exercise the same public Host on native Go and the experimental Zig adapter.
func TestGroupRandomSeedAndRestore(t *testing.T) {
	core := talk.New()
	for _, tc := range []struct {
		name  string
		seed  uint64
		bound int64
		want  []int64
	}{
		// Chapter 7's example sequences also pin the omitted seed's behavior.
		{"default", 0, 6, []int64{1, 6, 1, 3, 2, 6, 6, 6, 3, 5}},
		{"42", 42, 6, []int64{3, 6, 4, 4, 4, 5, 1, 6, 3, 4}},
		// Reference PCG32 draws at the Message Layer's integer-encoding boundary
		// and above int64's range. The full draw exposes any lost seed bits.
		{"2^53-1", 1<<53 - 1, 1 << 32, []int64{2690846382, 3068423584, 4189623404, 3372751797, 1536079964, 980249031, 2135247412, 3825867420, 2524189573, 2354684774}},
		{"2^53", 1 << 53, 1 << 32, []int64{3929308912, 2663406009, 2006952648, 1756007327, 3485266758, 1356251416, 3347250941, 3739316416, 3555910604, 345872001}},
		{"2^53+1", 1<<53 + 1, 1 << 32, []int64{58709951, 3290117647, 62292694, 1586102614, 677760595, 3625937943, 4161074495, 2954601643, 3281513055, 1740076113}},
		{"2^63", 1 << 63, 1 << 32, []int64{575596580, 3420060287, 1816562174, 1793633893, 4182232381, 3003343366, 2231703949, 3860417021, 694866410, 2487243822}},
		{"2^64-1", 1<<64 - 1, 1 << 32, []int64{3643879479, 3444271507, 2072954527, 2577256465, 1548663212, 3076993114, 651909780, 1443070400, 3080190164, 1280840548}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			options := talk.GroupOptions{}
			if tc.name != "default" {
				options.Seed = tc.seed
			}
			g := core.NewGroup(options)
			if _, err := g.Load(talk.LoadOptions{Name: "dice", Source: "on roll n\n return random(n)\nend roll\n"}); err != nil {
				t.Fatal(err)
			}
			draw := func(group *talk.Group, index int) {
				t.Helper()
				_, pending, err := group.Script("dice").Request(nil, talk.Message{Name: "roll", Args: []talk.Value{talk.Int(tc.bound)}})
				if err != nil {
					t.Fatal(err)
				}
				if _, err := group.Pump(time.Unix(1, 0), talk.PumpOptions{}); err != nil {
					t.Fatal(err)
				}
				select {
				case <-pending.Done():
				default:
					t.Fatal("random Request did not settle")
				}
				got, failure := pending.Result()
				if failure != nil || !got.Equal(talk.Int(tc.want[index])) {
					t.Fatalf("draw %d: got %v, failure %v; want %d", index+1, got, failure, tc.want[index])
				}
			}
			for i := range 5 {
				draw(g, i)
			}
			saved, err := g.Save()
			if err != nil {
				t.Fatal(err)
			}
			restored, _, err := core.Restore(saved, talk.RestoreOptions{})
			if err != nil {
				t.Fatal(err)
			}
			for i := 5; i < len(tc.want); i++ {
				draw(g, i)
				draw(restored, i)
			}
		})
	}
}
