// Package apicheck holds the AST check of the public embedding declarations.
// It is exercised by go test, outside the Core's execution path.
package apicheck

import (
	"bytes"
	"fmt"
	"go/ast"
	"go/format"
	"go/token"
	"sort"
	"strconv"
	"strings"
)

func render(node ast.Node) string {
	var out bytes.Buffer
	if err := format.Node(&out, token.NewFileSet(), node); err != nil {
		panic(err)
	}
	return out.String()
}

// Parameter names and grouping are not part of a Go signature. Public struct
// fields are; private representation fields are allowed even for opaque types.
func parameters(fields *ast.FieldList) {
	if fields == nil {
		return
	}
	var flattened []*ast.Field
	for _, field := range fields.List {
		count := len(field.Names)
		if count == 0 {
			count = 1
		}
		for range count {
			flattened = append(flattened, &ast.Field{Type: field.Type})
		}
	}
	fields.List = flattened
}

func declarations(file *ast.File) map[string]string {
	imports := map[string]string{}
	for _, imp := range file.Imports {
		path, err := strconv.Unquote(imp.Path.Value)
		if err != nil {
			panic(err)
		}
		parts := strings.Split(path, "/")
		name := parts[len(parts)-1]
		if imp.Name != nil {
			name = imp.Name.Name
		}
		imports[name] = path
	}
	ast.Inspect(file, func(node ast.Node) bool {
		switch n := node.(type) {
		case *ast.SelectorExpr:
			if name, ok := n.X.(*ast.Ident); ok {
				if path, ok := imports[name.Name]; ok {
					// Printed for comparison only, never compiled. Using the full
					// path lets import aliases compare without conflating packages.
					n.X = &ast.Ident{Name: strconv.Quote(path)}
				}
			}
		case *ast.FuncType:
			parameters(n.Params)
			parameters(n.Results)
		case *ast.StructType:
			var public []*ast.Field
			for _, field := range n.Fields.List {
				if len(field.Names) == 0 {
					// Even a private anonymous field can promote public members.
					// Compare all embeddings; opaque Spec types permit private
					// named fields, but cannot acquire an unchecked embedded API.
					public = append(public, field)
				} else {
					for _, name := range field.Names {
						if ast.IsExported(name.Name) {
							public = append(public, &ast.Field{Names: []*ast.Ident{name}, Type: field.Type, Tag: field.Tag})
						}
					}
				}
			}
			n.Fields.List = public
		}
		return true
	})
	result := map[string]string{}
	for _, declaration := range file.Decls {
		switch decl := declaration.(type) {
		case *ast.FuncDecl:
			if !ast.IsExported(decl.Name.Name) {
				continue
			}
			name, signature := decl.Name.Name, render(decl.Type)
			if decl.Recv != nil {
				receiver := decl.Recv.List[0].Type
				base := receiver
				if pointer, ok := base.(*ast.StarExpr); ok {
					base = pointer.X
				}
				name = render(base) + "." + name
				signature = "receiver " + render(receiver) + " " + signature
			}
			result[name] = signature
		case *ast.GenDecl:
			var previousType ast.Expr
			for _, entry := range decl.Specs {
				switch spec := entry.(type) {
				case *ast.TypeSpec:
					if ast.IsExported(spec.Name.Name) {
						alias := ""
						if spec.Assign.IsValid() {
							alias = "alias "
						}
						generic := ""
						if spec.TypeParams != nil {
							generic = render(spec.TypeParams)
						}
						result[spec.Name.Name] = "type " + alias + generic + render(spec.Type)
					}
				case *ast.ValueSpec:
					typeExpr := spec.Type
					if decl.Tok == token.CONST && typeExpr == nil && len(spec.Values) == 0 {
						typeExpr = previousType
					}
					previousType = typeExpr
					for _, name := range spec.Names {
						if ast.IsExported(name.Name) {
							typeText := "inferred"
							if typeExpr != nil {
								typeText = render(typeExpr)
							}
							result[name.Name] = decl.Tok.String() + " " + typeText
						}
					}
				}
			}
		}
	}
	return result
}

func compare(want, got map[string]string) (missing, failures []string) {
	for name, signature := range got {
		expected, ok := want[name]
		if !ok {
			failures = append(failures, "export absent from talk.go: "+name)
		} else if signature != expected {
			failures = append(failures, fmt.Sprintf("%s: got %s; talk.go declares %s", name, signature, expected))
		}
	}
	for name := range want {
		if _, ok := got[name]; !ok {
			missing = append(missing, name)
		}
	}
	sort.Strings(missing)
	sort.Strings(failures)
	return missing, failures
}
