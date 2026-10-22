package main

// `locale` for the Locales in locale_data.go: Collation and case mapping from
// golang.org/x/text, and names and number symbols from that pinned table. It
// follows tooling/stack/src/builtins.ts.

import (
	"slices"
	"strings"

	"golang.org/x/text/cases"
	"golang.org/x/text/collate"
	"golang.org/x/text/language"

	talk "github.com/odogono/odgn-talk/impl/go"
)

//go:generate node gen-locale-data.ts

type localeEntry struct {
	months, days map[string][]string // by "<form> <width>"
	symbols      numberSymbols
}

type numberSymbols struct {
	decimal, group, minus           string
	digits                          [10]string
	primary, secondary, minGrouping int64
}

type locale struct{}

// localeOf is the Locale in use, the call's tag or the Grant's, falling back
// by lookup, dropping subtags from the right, down to the root Locale `und`.
func localeOf(c *talk.Call, tag string) string {
	if tag == "" {
		tag, _ = c.Binding().(string)
	}
	subtags := strings.Split(tag, "-")
	for n := len(subtags); n > 0; n-- {
		candidate := strings.Join(subtags[:n], "-")
		for known := range localeData {
			if strings.EqualFold(known, candidate) {
				return known
			}
		}
	}
	return "und"
}

func word(options talk.Value, key string) string {
	s, _ := options.Get(key).AsText()
	return s
}

// collator is the Locale's Collation under the options' sensitivity and
// numeric ordering. A Collator is not safe for concurrent use.
func collator(tag string, options talk.Value) *collate.Collator {
	var opts []collate.Option
	switch word(options, "sensitivity") {
	case "base":
		opts = append(opts, collate.IgnoreDiacritics, collate.IgnoreCase, collate.IgnoreWidth)
	case "accent":
		opts = append(opts, collate.IgnoreCase, collate.IgnoreWidth)
	case "case":
		opts = append(opts, collate.IgnoreDiacritics, collate.IgnoreWidth)
	}
	if numeric, _ := options.Get("numeric").AsBool(); numeric {
		opts = append(opts, collate.Numeric)
	}
	return collate.New(language.Make(tag), opts...)
}

func (locale) Tag(c *talk.Call, tag string) (talk.Value, error) {
	return talk.Text(localeOf(c, tag))
}

func (locale) Compare(c *talk.Call, a, b, options talk.Value, tag string) (talk.Value, error) {
	x, _ := a.AsText()
	y, _ := b.AsText()
	return talk.Int(int64(collator(localeOf(c, tag), options).CompareString(x, y))), nil
}

// Rank gives each distinct text its dense, 1-based rank.
func (locale) Rank(c *talk.Call, texts, options talk.Value, tag string) (talk.Value, error) {
	col := collator(localeOf(c, tag), options)
	var distinct []string
	for i := range texts.Len() {
		s, _ := texts.Index(i + 1).AsText()
		if !slices.Contains(distinct, s) {
			distinct = append(distinct, s)
		}
	}
	slices.SortStableFunc(distinct, col.CompareString)
	ranks := make([]talk.Pair, len(distinct))
	rank := int64(0)
	for i, s := range distinct {
		if i == 0 || col.CompareString(distinct[i-1], s) != 0 {
			rank++
		}
		ranks[i] = talk.Pair{Key: s, Val: talk.Int(rank)}
	}
	return talk.Map(ranks...)
}

func (locale) Upper(c *talk.Call, s talk.Value, tag string) (talk.Value, error) {
	text, _ := s.AsText()
	return talk.Text(cases.Upper(language.Make(localeOf(c, tag))).String(text))
}

func (locale) Lower(c *talk.Call, s talk.Value, tag string) (talk.Value, error) {
	text, _ := s.AsText()
	return talk.Text(cases.Lower(language.Make(localeOf(c, tag))).String(text))
}

func (locale) NumberSymbols(c *talk.Call, tag string) (talk.Value, error) {
	s := localeData[localeOf(c, tag)].symbols
	digits := make([]talk.Value, len(s.digits))
	for i, d := range s.digits {
		digits[i] = mustText(d)
	}
	return talk.Map(
		talk.Pair{Key: "decimal", Val: mustText(s.decimal)},
		talk.Pair{Key: "group", Val: mustText(s.group)},
		talk.Pair{Key: "minus", Val: mustText(s.minus)},
		talk.Pair{Key: "digits", Val: talk.List(digits...)},
		talk.Pair{Key: "primaryGroup", Val: talk.Int(s.primary)},
		talk.Pair{Key: "secondaryGroup", Val: talk.Int(s.secondary)},
		talk.Pair{Key: "minGrouping", Val: talk.Int(s.minGrouping)},
	)
}

func names(list []string) talk.Value {
	vs := make([]talk.Value, len(list))
	for i, s := range list {
		vs[i] = mustText(s)
	}
	return talk.List(vs...)
}

func (locale) MonthNames(c *talk.Call, options talk.Value, tag string) (talk.Value, error) {
	return names(localeData[localeOf(c, tag)].months[word(options, "form")+" "+word(options, "width")]), nil
}

// DayNames start on Monday.
func (locale) DayNames(c *talk.Call, options talk.Value, tag string) (talk.Value, error) {
	return names(localeData[localeOf(c, tag)].days[word(options, "form")+" "+word(options, "width")]), nil
}
