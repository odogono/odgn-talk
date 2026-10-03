package unicode

import (
	"bufio"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/odogono/odgn-talk/impl/go/internal/generated"
)

// Tests consume the pinned UCD, never another Core's implementation or output.
func pinned(t *testing.T, name string) []string {
	t.Helper()
	path := filepath.Join("../../../../.cache/unicode", generated.UnicodeVersion, name)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v; run bun run unicode:check from the repository root", err)
	}
	if got := fmt.Sprintf("%x", sha256.Sum256(data)); got != generated.SourceHashes[name] {
		t.Fatalf("%s: SHA-256 %s differs from the pinned source", name, got)
	}
	var rows []string
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	for scanner.Scan() {
		row := strings.TrimSpace(strings.SplitN(scanner.Text(), "#", 2)[0])
		if row != "" && !strings.HasPrefix(row, "@") {
			rows = append(rows, row)
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	return rows
}

func scalar(t *testing.T, text string) rune {
	t.Helper()
	n, err := strconv.ParseInt(text, 16, 32)
	if err != nil {
		t.Fatal(err)
	}
	return rune(n)
}

func sequence(t *testing.T, text string) string {
	t.Helper()
	var runes []rune
	for _, field := range strings.Fields(text) {
		runes = append(runes, scalar(t, field))
	}
	return string(runes)
}

func TestNormalizationConformance(t *testing.T) {
	first := map[rune]bool{}
	rows := pinned(t, "NormalizationTest.txt")
	for i, row := range rows {
		fields := strings.Split(row, ";")
		columns := make([]string, 5)
		for j := range columns {
			columns[j] = sequence(t, fields[j])
		}
		if points := []rune(columns[0]); len(points) == 1 {
			first[points[0]] = true
		}
		// NFC(c1)=NFC(c2)=NFC(c3)=c2; NFC(c4)=NFC(c5)=c4.
		for j, input := range columns {
			want := columns[1]
			if j >= 3 {
				want = columns[3]
			}
			got, err := NFC(input)
			if err != nil || got != want {
				t.Fatalf("row %d column %d: NFC(%U) = %U, %v; want %U", i+1, j+1, []rune(input), []rune(got), err, []rune(want))
			}
		}
	}
	// UAX #15 also requires NFC(X)=X for scalars absent from column 1.
	for cp := rune(0); cp <= 0x10ffff; cp++ {
		if (cp >= 0xd800 && cp <= 0xdfff) || first[cp] {
			continue
		}
		input := string(cp)
		if got, err := NFC(input); err != nil || got != input {
			t.Fatalf("absent scalar %U changed to %U: %v", cp, []rune(got), err)
		}
	}
	t.Logf("passed all five columns of %d normalization rows and absent scalars", len(rows))
}

func TestGraphemeConformance(t *testing.T) {
	rows := pinned(t, "auxiliary/GraphemeBreakTest.txt")
	for i, row := range rows {
		text := ""
		var want []int
		for _, token := range strings.Fields(row) {
			switch token {
			case "÷":
				want = append(want, len(text))
			case "×":
			default:
				text += string(scalar(t, token))
			}
		}
		got, err := Boundaries(text)
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Fatalf("row %d: boundaries(%U) = %v, %v; want %v", i+1, []rune(text), got, err, want)
		}
	}
	t.Logf("passed %d grapheme rows", len(rows))
}

func TestBoundarySentinels(t *testing.T) {
	for _, test := range []struct {
		text string
		want []int
	}{
		{"", []int{0}},
		{"ab", []int{0, 1, 2}},
		{"\r\n", []int{0, 2}},
		{"e\u0301", []int{0, 3}},
	} {
		got, err := Boundaries(test.text)
		if err != nil || !reflect.DeepEqual(got, test.want) {
			t.Fatalf("boundaries(%q) = %v, %v; want %v", test.text, got, err, test.want)
		}
	}
}

func TestSimpleFoldingConformance(t *testing.T) {
	want := map[rune]rune{}
	for _, row := range pinned(t, "CaseFolding.txt") {
		fields := strings.Split(row, ";")
		status := strings.TrimSpace(fields[1])
		if status == "C" || status == "S" {
			want[scalar(t, strings.TrimSpace(fields[0]))] = scalar(t, strings.TrimSpace(fields[2]))
		}
	}
	for cp := rune(0); cp <= 0x10ffff; cp++ {
		if cp >= 0xd800 && cp <= 0xdfff {
			continue
		}
		mapped, ok := want[cp]
		if !ok {
			mapped = cp
		}
		if got, err := Fold(string(cp)); err != nil || got != string(mapped) {
			t.Fatalf("fold(%U) = %U, %v; want %U", cp, []rune(got), err, mapped)
		}
	}
	if got, _ := Fold("Straße İ Σς"); got != "straße İ σσ" {
		t.Fatalf("simple folding expanded text or applied Turkic folding: %q", got)
	}
}

func TestInvalidUTF8(t *testing.T) {
	for _, input := range []string{"\xff", "\xc0\xaf", "\xed\xa0\x80", "\xf4\x90\x80\x80", "\xe2\x82"} {
		if _, err := NFC(input); err == nil {
			t.Fatalf("NFC accepted %x", input)
		}
		if _, err := Fold(input); err == nil {
			t.Fatalf("Fold accepted %x", input)
		}
		if _, err := Boundaries(input); err == nil {
			t.Fatalf("Boundaries accepted %x", input)
		}
		if _, err := Words(input); err == nil {
			t.Fatalf("Words accepted %x", input)
		}
		if _, err := WordBreaks(input); err == nil {
			t.Fatalf("WordBreaks accepted %x", input)
		}
	}
	if got, err := NFC("\ufeff\ufffd"); err != nil || got != "\ufeff\ufffd" {
		t.Fatalf("valid BOM/replacement scalar refused: %q, %v", got, err)
	}
}

func TestWordsAndWordBreaks(t *testing.T) {
	for _, test := range []struct {
		text   string
		words  []string
		breaks []int
	}{
		{"cat, dog", []string{"cat,", "dog"}, []int{0, 4, 5, 8}},
		{" \u0301cat\u00a0dog\r\n", []string{"cat", "dog"}, []int{3, 6, 8, 11}},
		{"\u200bcat", []string{"\u200bcat"}, []int{0, 6}},
		{"👩‍💻!", []string{"👩‍💻!"}, []int{0, 12}},
		{"", nil, nil},
		{"\t \r\n", nil, nil},
	} {
		spans, err := Words(test.text)
		if err != nil {
			t.Fatal(err)
		}
		var got []string
		for _, span := range spans {
			got = append(got, test.text[span.Start:span.End])
		}
		if !reflect.DeepEqual(got, test.words) {
			t.Fatalf("words(%q) = %v, want %v", test.text, got, test.words)
		}
		breaks, err := WordBreaks(test.text)
		if err != nil || !reflect.DeepEqual(breaks, test.breaks) {
			t.Fatalf("word breaks(%q) = %v, %v; want %v", test.text, breaks, err, test.breaks)
		}
	}
}
