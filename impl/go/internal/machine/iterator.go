package machine

import (
	"github.com/odogono/odgn-talk/impl/go/internal/decimal"
	"github.com/odogono/odgn-talk/impl/go/internal/value"
)

// Iterators retain a snapshot and advance by rebinding, so a rejected charge
// never advances the original iterator. Ranges are walked without expansion.
func advanceIterator(it value.IteratorData) (value.IteratorData, value.Value, bool) {
	switch it.Snapshot.Kind {
	case value.List:
		if it.Position >= len(it.Snapshot.Items()) {
			return it, value.Value{}, false
		}
		item := it.Snapshot.Items()[it.Position]
		it.Position++
		return it, item, true
	case value.Range:
		if it.Done {
			return it, value.Value{}, false
		}
		item := value.Fields{Kind: value.Number, Number: it.Current}.Value()
		if it.Current.Compare(it.Snapshot.Items()[1].Number()) == 0 {
			it.Done = true
		} else {
			it.Current, _ = decimal.Calculate("+", it.Current, decimal.FromInt(1))
		}
		return it, item, true
	default:
		if it.Remaining.Sign() == 0 {
			return it, value.Value{}, false
		}
		it.Remaining, _ = decimal.Calculate("-", it.Remaining, decimal.FromInt(1))
		return it, value.Value{}, true
	}
}
