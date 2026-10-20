package northtalk

// Extend adds an Entry atomically, keeping existing frames and Function Values.
func (s *Script) Extend(source string) error {
	return s.group.backend.extend(s, source)
}
