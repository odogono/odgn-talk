
baseline host:	file format mach-o arm64

Disassembly of section __TEXT,__text:

000000010004052c <_value.scalar>:
10004052c: a9bd57f6    	stp	x22, x21, [sp, #-0x30]!
100040530: a9014ff4    	stp	x20, x19, [sp, #0x10]
100040534: a9027bfd    	stp	x29, x30, [sp, #0x20]
100040538: 910083fd    	add	x29, sp, #0x20
10004053c: aa0203f4    	mov	x20, x2
100040540: aa0103f5    	mov	x21, x1
100040544: aa0003f3    	mov	x19, x0
100040548: a9402020    	ldp	x0, x8, [x1]
10004054c: b9412049    	ldr	w9, [x2, #0x120]
100040550: 71001d3f    	cmp	w9, #0x7
100040554: 5400020c    	b.gt	0x100040594 <_value.scalar+0x68>
100040558: 7100193f    	cmp	w9, #0x6
10004055c: 54000360    	b.eq	0x1000405c8 <_value.scalar+0x9c>
100040560: 71001d3f    	cmp	w9, #0x7
100040564: 540002a1    	b.ne	0x1000405b8 <_value.scalar+0x8c>
100040568: f940068a    	ldr	x10, [x20, #0x8]
10004056c: b40009ca    	cbz	x10, 0x1000406a4 <_value.scalar+0x178>
100040570: d2800009    	mov	x9, #0x0                ; =0
100040574: f940028b    	ldr	x11, [x20]
100040578: 9100416b    	add	x11, x11, #0x10
10004057c: f841856c    	ldr	x12, [x11], #0x18
100040580: f940ad8c    	ldr	x12, [x12, #0x158]
100040584: 9acc6529    	umax	x9, x9, x12
100040588: f100054a    	subs	x10, x10, #0x1
10004058c: 54ffff81    	b.ne	0x10004057c <_value.scalar+0x50>
100040590: 14000017    	b	0x1000405ec <_value.scalar+0xc0>
100040594: 7100213f    	cmp	w9, #0x8
100040598: 54000780    	b.eq	0x100040688 <_value.scalar+0x15c>
10004059c: 7100313f    	cmp	w9, #0xc
1000405a0: 540000c1    	b.ne	0x1000405b8 <_value.scalar+0x8c>
1000405a4: f9401689    	ldr	x9, [x20, #0x28]
1000405a8: f940ad29    	ldr	x9, [x9, #0x158]
1000405ac: b1000536    	adds	x22, x9, #0x1
1000405b0: 54000882    	b.hs	0x1000406c0 <_value.scalar+0x194>
1000405b4: 14000010    	b	0x1000405f4 <_value.scalar+0xc8>
1000405b8: 7100393f    	cmp	w9, #0xe
1000405bc: 54000902    	b.hs	0x1000406dc <_value.scalar+0x1b0>
1000405c0: d2800016    	mov	x22, #0x0               ; =0
1000405c4: 1400000c    	b	0x1000405f4 <_value.scalar+0xc8>
1000405c8: f940068a    	ldr	x10, [x20, #0x8]
1000405cc: b400074a    	cbz	x10, 0x1000406b4 <_value.scalar+0x188>
1000405d0: d2800009    	mov	x9, #0x0                ; =0
1000405d4: f940028b    	ldr	x11, [x20]
1000405d8: f840856c    	ldr	x12, [x11], #0x8
1000405dc: f940ad8c    	ldr	x12, [x12, #0x158]
1000405e0: 9acc6529    	umax	x9, x9, x12
1000405e4: f100054a    	subs	x10, x10, #0x1
1000405e8: 54ffff81    	b.ne	0x1000405d8 <_value.scalar+0xac>
1000405ec: b1000536    	adds	x22, x9, #0x1
1000405f0: 54000682    	b.hs	0x1000406c0 <_value.scalar+0x194>
1000405f4: dac143fe    	xpaci	x30
1000405f8: f9400108    	ldr	x8, [x8]
1000405fc: 52802e01    	mov	w1, #0x170              ; =368
100040600: 52800082    	mov	w2, #0x4                ; =4
100040604: aa1e03e3    	mov	x3, x30
100040608: d63f0100    	blr	x8
10004060c: b40005a0    	cbz	x0, 0x1000406c0 <_value.scalar+0x194>
100040610: 4f05e540    	movi.16b	v0, #0xaa
100040614: ad0a8000    	stp	q0, q0, [x0, #0x150]
100040618: ad098000    	stp	q0, q0, [x0, #0x130]
10004061c: ad088000    	stp	q0, q0, [x0, #0x110]
100040620: ad078000    	stp	q0, q0, [x0, #0xf0]
100040624: ad068000    	stp	q0, q0, [x0, #0xd0]
100040628: ad058000    	stp	q0, q0, [x0, #0xb0]
10004062c: ad048000    	stp	q0, q0, [x0, #0x90]
100040630: ad038000    	stp	q0, q0, [x0, #0x70]
100040634: ad028000    	stp	q0, q0, [x0, #0x50]
100040638: ad018000    	stp	q0, q0, [x0, #0x30]
10004063c: ad008000    	stp	q0, q0, [x0, #0x10]
100040640: 3d800000    	str	q0, [x0]
100040644: f2400c1f    	tst	x0, #0xf
100040648: 54000481    	b.ne	0x1000406d8 <_value.scalar+0x1ac>
10004064c: 9104e008    	add	x8, x0, #0x138
100040650: 3dc002a0    	ldr	q0, [x21]
100040654: 3d800100    	str	q0, [x8]
100040658: aa0003f5    	mov	x21, x0
10004065c: aa1403e1    	mov	x1, x20
100040660: 52802602    	mov	w2, #0x130              ; =304
100040664: 9406f4a6    	bl	0x1001fd8fc <_writev+0x1001fd8fc>
100040668: 52800008    	mov	w8, #0x0                ; =0
10004066c: 52800029    	mov	w9, #0x1                ; =1
100040670: f9009aa9    	str	x9, [x21, #0x130]
100040674: 7902d2bf    	strh	wzr, [x21, #0x168]
100040678: a915feb6    	stp	x22, xzr, [x21, #0x158]
10004067c: a914febf    	stp	xzr, xzr, [x21, #0x148]
100040680: f9000275    	str	x21, [x19]
100040684: 14000010    	b	0x1000406c4 <_value.scalar+0x198>
100040688: a9402a89    	ldp	x9, x10, [x20]
10004068c: f940ad29    	ldr	x9, [x9, #0x158]
100040690: f940ad4a    	ldr	x10, [x10, #0x158]
100040694: 9aca6529    	umax	x9, x9, x10
100040698: b1000536    	adds	x22, x9, #0x1
10004069c: 54000122    	b.hs	0x1000406c0 <_value.scalar+0x194>
1000406a0: 17ffffd5    	b	0x1000405f4 <_value.scalar+0xc8>
1000406a4: d2800009    	mov	x9, #0x0                ; =0
1000406a8: b1000536    	adds	x22, x9, #0x1
1000406ac: 54fffa43    	b.lo	0x1000405f4 <_value.scalar+0xc8>
1000406b0: 14000004    	b	0x1000406c0 <_value.scalar+0x194>
1000406b4: d2800009    	mov	x9, #0x0                ; =0
1000406b8: b1000536    	adds	x22, x9, #0x1
1000406bc: 54fff9c3    	b.lo	0x1000405f4 <_value.scalar+0xc8>
1000406c0: 528000a8    	mov	w8, #0x5                ; =5
1000406c4: 79001268    	strh	w8, [x19, #0x8]
1000406c8: a9427bfd    	ldp	x29, x30, [sp, #0x20]
1000406cc: a9414ff4    	ldp	x20, x19, [sp, #0x10]
1000406d0: a8c357f6    	ldp	x22, x21, [sp], #0x30
1000406d4: d65f03c0    	ret
1000406d8: 9406b9a0    	bl	0x1001eed58 <_debug.FullPanic((function 'defaultPanic')).incorrectAlignment>
1000406dc: 9406b894    	bl	0x1001ee92c <_debug.FullPanic((function 'defaultPanic')).corruptSwitch>
